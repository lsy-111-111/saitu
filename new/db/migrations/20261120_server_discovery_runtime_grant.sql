-- Add a separate server authority without expanding or updating local grants.
alter table saitu_discovery_runtime_grants
  drop constraint if exists saitu_discovery_runtime_grants_run_id_check,
  drop constraint if exists saitu_discovery_runtime_grants_main_run_id_check,
  drop constraint if exists saitu_discovery_runtime_grants_grant_version_check,
  drop constraint if exists saitu_discovery_runtime_grants_authorization_label_check;

do $$ begin
if not exists (select 1 from pg_constraint
  where conrelid='saitu_discovery_runtime_grants'::regclass and conname='saitu_discovery_runtime_scope_check') then
  alter table saitu_discovery_runtime_grants add constraint saitu_discovery_runtime_scope_check check ((
    (grant_version='saitu.discovery-runtime.v1'
      and authorization_label='user-approved-20261119-discovery-implementation'
      and run_id ~ '^saitu-discovery-[a-f0-9]{32}$'
      and main_run_id ~ '^saitu-local-[a-f0-9]{32}$')
    or (grant_version='saitu.discovery-runtime.v2'
      and authorization_label='user-approved-20261120-server-deployment'
      and main_run_id ~ '^saitu-server-[a-f0-9]{32}$'
      and run_id=replace(main_run_id,'saitu-server-','saitu-discovery-server-')
      and jsonb_typeof(policy)='object'
      and policy->>'version'='saitu.discovery-runtime.v2'
      and policy->>'authorization'='user-approved-20261120-server-deployment'
      and policy->>'runtimeMode'='server'
      and policy->>'origin'='https://gzhanchuang.com'
      and policy->'concurrency'='4'::jsonb
      and policy ? 'dailyCallLimit' and policy->'dailyCallLimit'='null'::jsonb
      and policy->>'budgetMode'='uncapped'
      and policy->'reportDeadlineMs'='180000'::jsonb
      and policy->'automaticRetries'='1'::jsonb)
  ) is true);
end if;
end $$;
