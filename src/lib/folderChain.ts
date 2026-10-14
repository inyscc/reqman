//
// 目录层脚本的编排数据（任务 2.4）。
//
// 目录层不是"一个槽位"而是一条链：请求所属的目录加上它的**全部递归祖先目录**，由外到内
// 都要参与脚本编排（spec: 脚本执行时机与顺序）。这里负责把那条链取出来，并把它编成带层级
// 标签的脚本段——标签是错误报告能指认"哪一层炸了"的唯一依据（design D2）。
//
import type { Commands } from './commands';
import type { ScriptSegment } from './scriptRuntime';
import type { Folder } from './types';

/**
 * 上溯的最大层数。
 *
 * 正常数据远低于它；触顶只可能是坏数据（`folder_set_parent` 会拒绝把目录移进自己的后代，
 * 因此环本不该存在）。触顶时按已取到的链执行并报告，而不是让发送卡在这里（design D1）。
 */
export const FOLDER_CHAIN_MAX_DEPTH = 64;

export type FolderChainResult = {
  /** 由外到内的目录链：最外层祖先在前，请求的直接父级在最后。 */
  folders: Folder[];
  /** 链异常时的一次性说明（成环或超出深度上限）；正常时为 `null`。 */
  error: string | null;
};

/**
 * 取某个请求当前的目录归属，并沿 `parent_folder_id` 上溯成整条链。
 *
 * 归属取自**请求自身的当前记录**，而不是标签草稿里的那份副本：草稿可能是拖动之前打开的，
 * 它里面的 `folder_id` 会一直陈旧（这正是本次实测"目录脚本不执行"的成因），发送不该建立在
 * 一份可能过期的副本上（design D1）。
 */
export async function loadRequestFolderChain(
  client: Pick<Commands, 'requestGet' | 'folderGet'>,
  requestId: string,
): Promise<FolderChainResult> {
  const request = await client.requestGet(requestId);
  const innerToOuter: Folder[] = [];
  const visited = new Set<string>();
  let current = request.folder_id ?? null;
  let error: string | null = null;

  while (current) {
    if (visited.has(current)) {
      error = `目录归属成环，已按取到的 ${innerToOuter.length} 层目录执行`;
      break;
    }

    if (innerToOuter.length >= FOLDER_CHAIN_MAX_DEPTH) {
      error = `目录层级超过 ${FOLDER_CHAIN_MAX_DEPTH} 层，已按取到的层执行`;
      break;
    }

    visited.add(current);
    const folder = await client.folderGet(current);
    innerToOuter.push(folder);
    current = folder.parent_folder_id ?? null;
  }

  return { folders: innerToOuter.reverse(), error };
}

/**
 * 把一条目录链编成脚本段。
 *
 * 标签里带上目录名**与它在链上的位置**：目录允许重名，只给名字的报错无法指认到底是哪一层
 * （design D2）。
 */
export function folderSegments(
  folders: Folder[],
  pick: (folder: Folder) => string | null | undefined,
): ScriptSegment[] {
  return folders.map((folder, index) => ({
    label: `目录第 ${index + 1} 层「${folder.name}」`,
    code: pick(folder) ?? null,
  }));
}
