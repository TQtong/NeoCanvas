-- ============================================================================
-- 迁移 0002：枚举类型
--
-- 这些枚举的取值与 types/enums.ts 的字面量联合逐字一致，是数据库、Edge Functions
-- 与前端三方共享的取值契约（第 03 篇第二节）。
-- ============================================================================

-- 生成模态：图像 / 视频 / 文本
create type public.modality as enum ('image', 'video', 'text');

-- 生成任务状态：状态机单向转移 pending → running →（succeeded/failed/cancelled）
create type public.generation_status as enum (
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled'
);

-- 消息角色
create type public.message_role as enum ('user', 'assistant', 'system');

-- 资产种类
create type public.asset_kind as enum ('image', 'video');

-- 资产来源：上传 / 生成
create type public.asset_source as enum ('upload', 'generation');

-- 画布节点类型（与 React Flow nodeTypes 注册键一一对应）
create type public.node_type as enum (
  'image',
  'text',
  'shape',
  'drawing',
  'video',
  'generation_placeholder',
  'frame'
);
