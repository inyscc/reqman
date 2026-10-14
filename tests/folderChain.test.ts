//
// 目录链解析（change: run-ancestor-folder-scripts，任务 1.1 / 2.2）。
//
// 验的是：链由外到内、归属取自后端当前记录、坏数据（成环 / 超深）不把发送卡死，
// 以及目录段的标签带名字与链上位置（同名目录据此区分）。
//
import { describe, expect, it } from 'vitest';
import {
  FOLDER_CHAIN_MAX_DEPTH,
  folderSegments,
  loadRequestFolderChain,
} from '../src/lib/folderChain';
import type { Commands } from '../src/lib/commands';
import {
  defaultSettings,
  emptyAuth,
  emptyBody,
  type Folder,
  type SavedRequest,
} from '../src/lib/types';

function folder(
  id: string,
  parent: string | null,
  name = id,
  scripts: { pre?: string | null; test?: string | null } = {},
): Folder {
  return {
    id,
    collection_id: 'c1',
    parent_folder_id: parent,
    name,
    auth: emptyAuth(),
    pre_request_script: scripts.pre ?? null,
    test_script: scripts.test ?? null,
    sort_order: 0,
  };
}

function request(id: string, folderId: string | null): SavedRequest {
  return {
    id,
    collection_id: 'c1',
    folder_id: folderId,
    name: '请求',
    method: 'GET',
    url: 'https://api.test/',
    params: [],
    headers: [],
    body: emptyBody(),
    auth: emptyAuth(),
    settings: defaultSettings(),
    sort_order: 0,
  };
}

/** 只暴露链需要的两个出口：请求的**当前**归属，与逐级取目录。 */
function fakeClient(
  requestFolderId: string | null,
  folders: Folder[],
): { client: Pick<Commands, 'requestGet' | 'folderGet'>; folderGets: string[] } {
  const byId = new Map(folders.map((item) => [item.id, item]));
  const folderGets: string[] = [];

  return {
    folderGets,
    client: {
      requestGet: async (id: string) => request(id, requestFolderId),
      folderGet: async (id: string) => {
        folderGets.push(id);
        const found = byId.get(id);
        if (!found) throw new Error(`没有这个目录：${id}`);
        return found;
      },
    },
  };
}

describe('目录链', () => {
  it('三层嵌套返回由外到内的三个目录', async () => {
    const { client, folderGets } = fakeClient('f3', [
      folder('f1', null, '最外层'),
      folder('f2', 'f1', '中间层'),
      folder('f3', 'f2', '最内层'),
    ]);

    const chain = await loadRequestFolderChain(client, 'r1');

    expect(chain.folders.map((item) => item.name)).toEqual(['最外层', '中间层', '最内层']);
    expect(chain.error).toBeNull();
    // 从请求的直接父级逐级上溯，而不是从头往下找
    expect(folderGets).toEqual(['f3', 'f2', 'f1']);
  });

  it('不属于任何目录时返回空链，且不查目录', async () => {
    const { client, folderGets } = fakeClient(null, []);

    const chain = await loadRequestFolderChain(client, 'r1');

    expect(chain.folders).toEqual([]);
    expect(chain.error).toBeNull();
    expect(folderGets).toEqual([]);
  });

  it('归属取自请求当前的记录（草稿里那份陈旧副本不参与）', async () => {
    const folders = new Map<string, Folder>([
      ['f-old', folder('f-old', null, '旧目录')],
      ['f-new', folder('f-new', null, '新目录')],
    ]);
    let currentFolder = 'f-old';
    const client: Pick<Commands, 'requestGet' | 'folderGet'> = {
      requestGet: async (id) => request(id, currentFolder),
      folderGet: async (id) => folders.get(id) as Folder,
    };

    // 拖拽落库之后，下一次解析就该按新归属走——不需要重开标签，也不需要谁去刷新副本
    const before = await loadRequestFolderChain(client, 'r1');
    currentFolder = 'f-new';
    const after = await loadRequestFolderChain(client, 'r1');

    expect(before.folders.map((item) => item.name)).toEqual(['旧目录']);
    expect(after.folders.map((item) => item.name)).toEqual(['新目录']);
  });

  it('成环时不死循环：按取到的链执行并报告一次', async () => {
    // f1 的父级是 f2、f2 的父级是 f1——坏数据，不能把发送挂在这里
    const { client, folderGets } = fakeClient('f2', [
      folder('f1', 'f2', '甲'),
      folder('f2', 'f1', '乙'),
    ]);

    const chain = await loadRequestFolderChain(client, 'r1');

    expect(chain.folders.map((item) => item.name)).toEqual(['甲', '乙']);
    expect(chain.error).toContain('成环');
    expect(folderGets).toHaveLength(2);
  });

  it('超过深度上限时停止上溯并报告', async () => {
    const deep: Folder[] = [];
    for (let index = 0; index < FOLDER_CHAIN_MAX_DEPTH + 6; index += 1) {
      deep.push(folder(`f${index}`, index === 0 ? null : `f${index - 1}`));
    }

    const { client } = fakeClient(`f${FOLDER_CHAIN_MAX_DEPTH + 5}`, deep);
    const chain = await loadRequestFolderChain(client, 'r1');

    expect(chain.folders).toHaveLength(FOLDER_CHAIN_MAX_DEPTH);
    expect(chain.error).toContain('超过');
  });
});

describe('目录段', () => {
  it('标签带目录名与链上位置，同名目录因此可区分', () => {
    const segments = folderSegments(
      [folder('a', null, '重复', { pre: 'a();' }), folder('b', 'a', '重复', { test: 'b();' })],
      (item) => item.pre_request_script,
    );

    expect(segments).toEqual([
      { label: '目录第 1 层「重复」', code: 'a();' },
      { label: '目录第 2 层「重复」', code: null },
    ]);
  });
});
