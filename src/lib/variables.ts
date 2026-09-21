// 同名组里「谁生效」的唯一一份判定（design D13）。
//
// 这条规则同时被三处消费：变量表格的遮蔽标记、只读浮层与脚本运行时。Rust 侧的解析层
// （`layer_for` 跳过禁用条目后顺序覆写）实现的是同一条规则——三处各写一遍必然漂移，
// 会出现「界面说 A 生效、实际发出的是 B」。
//
// 规则：同名组里顺序最靠后的**启用**条目生效；生效条被禁用时退回上一条启用条目；
// 全组都被禁用时该名字未定义。

import type { Variable } from './types';

/** 按名称分组，保持传入的顺序（列表顺序即生效顺序）。 */
export function groupByName(variables: Variable[]): Map<string, Variable[]> {
  const groups = new Map<string, Variable[]>();
  for (const variable of variables) {
    const group = groups.get(variable.name);
    if (group) group.push(variable);
    else groups.set(variable.name, [variable]);
  }
  return groups;
}

/** 一组同名条目里生效的那一条；全组禁用时返回 undefined。 */
export function effectiveVariable(group: Variable[]): Variable | undefined {
  for (let index = group.length - 1; index >= 0; index -= 1) {
    if (group[index].enabled) return group[index];
  }
  return undefined;
}

/**
 * 名称 → 生效条目。
 *
 * 被禁用的条目不会进入结果，因此拿它当作用域视图（脚本运行时、浮层、预览）时
 * 天然满足「禁用条目不参与解析」。
 */
export function effectiveByName(variables: Variable[]): Map<string, Variable> {
  const out = new Map<string, Variable>();
  for (const [name, group] of groupByName(variables)) {
    const effective = effectiveVariable(group);
    if (effective) out.set(name, effective);
  }
  return out;
}

/**
 * 该行是否被下方的同名条目遮蔽（界面上的「被覆盖」标记的判据）。
 *
 * 判据是结构性的：**自己启用**，且同名组里存在更靠后的**启用**条目。
 * 因此被禁用的行、以及当前生效的行都不带标记——勾掉靠后那条时，两个标记同时消失。
 */
export function isShadowed(variable: Variable, variables: Variable[]): boolean {
  if (!variable.enabled) return false;
  const group = groupByName(variables).get(variable.name) ?? [];
  const effective = effectiveVariable(group);
  return effective !== undefined && effective.id !== variable.id;
}
