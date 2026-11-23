-- A fresh, operation-scoped local authority. Existing finite grants are unchanged.
create table if not exists saitu_discovery_runtime_grants (
  run_id text primary key references ai_spend_budgets(run_id)
    check (run_id ~ '^saitu-discovery-[a-f0-9]{32}$'),
  main_run_id text not null references ai_spend_budgets(run_id)
    check (main_run_id ~ '^saitu-local-[a-f0-9]{32}$'),
  grant_version text not null check (grant_version = 'saitu.discovery-runtime.v1'),
  authorization_label text not null check (authorization_label = 'user-approved-20261119-discovery-implementation'),
  policy jsonb not null,
  policy_sha256 text not null check (policy_sha256 ~ '^[a-f0-9]{64}$'),
  budget_mode text not null default 'uncapped' check (budget_mode='uncapped'),
  hard_limit_micros bigint check (hard_limit_micros is null),
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
revoke all on saitu_discovery_runtime_grants from public;
