-- Flow Studio：运行节点固定真实 Provider 模型标识，而不是只记录目录 model_key。
create or replace function public.snapshot_workflow_run_node_provider()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_provider text;
  v_provider_model text;
begin
  if new.model_key is null then return new; end if;
  select provider, coalesce(nullif(default_params ->> 'providerModel', ''), key)
    into v_provider, v_provider_model
    from public.model_catalog
   where key = new.model_key;
  if found then
    new.provider := v_provider;
    new.resolved_provider_model := v_provider_model;
  end if;
  return new;
end;
$$;

drop trigger if exists workflow_run_nodes_snapshot_provider on public.workflow_run_nodes;
create trigger workflow_run_nodes_snapshot_provider
  before insert or update of model_key, resolved_provider_model
  on public.workflow_run_nodes
  for each row execute function public.snapshot_workflow_run_node_provider();

revoke all on function public.snapshot_workflow_run_node_provider() from public, anon, authenticated;
grant execute on function public.snapshot_workflow_run_node_provider() to service_role;
