-- ============================================================================
-- 迁移 0015：海报整组重新编排的「文字节点原子替换」RPC
--
-- regenerate-poster 边缘函数重排海报时，需要「删除旧叠层文字 + 写入新文字节点」两步必须原子：
-- 否则 PostgREST 的 delete / insert 是两条独立语句，中途失败会留下「无文字」或「新旧文字并存」
-- 的半应用海报（审查发现 #4/#5）。本 RPC 在单一事务内完成删除 + 插入。
--
-- p_delete_ids：要删除的旧叠层节点 id 数组（文字 / 形状 / 手绘）。
-- p_rows：新文字节点行的 jsonb 数组，键与 canvas_nodes 列对齐（来自 buildPosterTextNodeRows）。
-- 仅 service_role 可执行（边缘函数以管理员客户端调用）。
-- ============================================================================

create or replace function public.regenerate_poster_text_nodes(
  p_delete_ids uuid[],
  p_rows jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r jsonb;
begin
  -- 1) 删除旧叠层（文字 / 形状 / 手绘）。相连边由 canvas_edges 的外键级联处理。
  if p_delete_ids is not null and array_length(p_delete_ids, 1) is not null then
    delete from public.canvas_nodes where id = any (p_delete_ids);
  end if;

  -- 2) 写入新文字节点（显式列，created_at/updated_at 走默认）。
  if p_rows is not null and jsonb_typeof(p_rows) = 'array' then
    for r in select * from jsonb_array_elements(p_rows) loop
      insert into public.canvas_nodes (
        id, project_id, type, position_x, position_y, width, height,
        rotation, z_index, parent_id, data, created_by
      ) values (
        (r ->> 'id')::uuid,
        (r ->> 'project_id')::uuid,
        (r ->> 'type')::public.node_type,
        (r ->> 'position_x')::double precision,
        (r ->> 'position_y')::double precision,
        nullif(r ->> 'width', '')::double precision,
        nullif(r ->> 'height', '')::double precision,
        coalesce((r ->> 'rotation')::double precision, 0),
        coalesce((r ->> 'z_index')::integer, 0),
        nullif(r ->> 'parent_id', '')::uuid,
        coalesce(r -> 'data', '{}'::jsonb),
        (r ->> 'created_by')::uuid
      );
    end loop;
  end if;
end;
$$;

comment on function public.regenerate_poster_text_nodes is '海报整组重新编排：在单一事务内删除旧叠层文字节点并写入新文字节点。';

revoke all on function public.regenerate_poster_text_nodes(uuid[], jsonb) from public, anon, authenticated;
grant execute on function public.regenerate_poster_text_nodes(uuid[], jsonb) to service_role;
