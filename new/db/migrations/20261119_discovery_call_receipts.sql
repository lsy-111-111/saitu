-- Content-free durable dispatch/settlement evidence for the discovery ledger.
-- No questionnaire, response text, credentials, or model reasoning is stored.
create table if not exists saitu_discovery_call_receipts (
  call_id uuid primary key references ai_spend_ledger(id),
  run_id text not null references saitu_discovery_runtime_grants(run_id),
  hard_deadline_at timestamptz not null,
  dispatched_at timestamptz,
  completed_at timestamptz,
  input_tokens bigint check (input_tokens >= 0),
  output_tokens bigint check (output_tokens >= 0),
  cached_input_tokens bigint check (cached_input_tokens >= 0 and cached_input_tokens <= input_tokens),
  usage_cost_micros bigint check (usage_cost_micros >= 0),
  created_at timestamptz not null default now(),
  check ((input_tokens is null and output_tokens is null and cached_input_tokens is null and usage_cost_micros is null)
    or (input_tokens is not null and output_tokens is not null and cached_input_tokens is not null and usage_cost_micros is not null))
);
create index if not exists saitu_discovery_call_receipts_reconcile on saitu_discovery_call_receipts(run_id,hard_deadline_at);
revoke all on saitu_discovery_call_receipts from public;
