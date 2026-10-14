// 组件层的提示取值源（change: show-variable-values-on-hover，任务 2.3 的接线）。
//
// 源随「工作区 / 环境 / 集合」变化而重建：那三者不变时它内部缓存着变量列表（一次悬停不该
// 反复问后端），一变就换一份新的——把失效规则交给「重建」而不是「猜什么时候该清缓存」。

import { useMemo } from 'react';
import {
  createVariableHoverSource,
  type VariableHoverSource,
  type VariableHoverWiring,
} from './variableHover';

export function useVariableHoverSource(
  wiring: VariableHoverWiring | null | undefined,
): VariableHoverSource | null {
  // 逐个取出、按值做依赖：调用方通常在渲染里就地写对象字面量，用对象本身做依赖会每次重建
  const client = wiring?.client ?? null;
  const workspaceId = wiring?.workspaceId ?? null;
  const environmentId = wiring?.environmentId ?? null;
  const collectionId = wiring?.collectionId ?? null;

  return useMemo(
    () =>
      client && workspaceId
        ? createVariableHoverSource(client, { workspaceId, environmentId, collectionId })
        : null,
    [client, workspaceId, environmentId, collectionId],
  );
}
