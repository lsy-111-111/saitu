-- Independent finite local runtime. This does not grant any historical experiment.
create table if not exists saitu_local_runtime_grants (
  run_id text primary key references ai_spend_budgets(run_id)
    check (run_id ~ '^saitu-local-[a-f0-9]{32}$'),
  phase text not null check (phase in ('calibration','formal','repair','performance','reserve')),
  effort_policy jsonb not null check (effort_policy = '{"version":"saitu.effort-policy.v1","rank":"low","explain":"low","review":"low"}'::jsonb),
  effort_policy_sha256 text not null check (effort_policy_sha256 ~ '^[a-f0-9]{64}$'),
  hard_limit_micros bigint not null check (hard_limit_micros > 0 and hard_limit_micros <= 300000000),
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
revoke all on saitu_local_runtime_grants from public;
