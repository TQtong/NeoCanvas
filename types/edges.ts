/**
 * 画布边数据契约。
 *
 * 边在本产品中是次要构件，主要用于记录「生成血缘」（某图由某参考节点派生而来）。
 *
 * @module types/edges
 */

/** 边类型取值。`default` 为普通连线，`lineage` 表示生成血缘。 */
export const EDGE_TYPES = ['default', 'lineage'] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

/**
 * `canvas_edges.data` 的结构。
 *
 * 以 `type` 别名声明（含隐式索引签名），以满足 React Flow `Edge<T>` 的
 * `Record<string, unknown>` 约束。
 */
export type EdgeData = {
  /** 血缘说明（如「以此为参考再生成」）。 */
  note?: string;
  /** 派生该目标节点的生成任务标识。 */
  generationId?: string;
  /** 标签文本（在边中点渲染）。 */
  label?: string;
};
