/**
 * 画布边数据契约。
 *
 * 边在本产品中有多类用途：
 * - `lineage`：记录「生成血缘」（某图由某参考节点派生而来），多由服务端写入；
 * - `sequence`：用户手动串接的「工作流序列」，把若干图片 / 视频节点按方向连成有序链，
 *   作为「逐段首尾帧」视频合成的关键帧顺序（第 04 篇画布连线、第 05 篇生成编排）；
 * - `annotation`：把一个文字节点连到某张图，使其成为该图的「描述 / 提示词」，
 *   生成序列视频时按帧拼进提示词。
 *
 * @module types/edges
 */

/**
 * 边类型取值。
 * - `default`：普通连线；
 * - `lineage`：生成血缘；
 * - `sequence`：工作流序列（图片有序链 → 视频）；
 * - `annotation`：图片描述（文字节点 → 图）。
 */
export const EDGE_TYPES = ['default', 'lineage', 'sequence', 'annotation'] as const;
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
