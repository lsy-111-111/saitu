-- Keep content-free task/dispatch evidence while removing expired legacy bodies.
-- Runtime roles retain their existing grants and cannot read the maintenance cursor.
alter table competition_decision_states
  add column if not exists content_redacted_at timestamptz,
  alter column ciphertext drop not null,
  alter column iv drop not null,
  alter column tag drop not null;
alter table competition_decision_runs
  add column if not exists content_redacted_at timestamptz,
  alter column ciphertext drop not null,
  alter column iv drop not null,
  alter column tag drop not null;
alter table competition_decision_chat_requests
  add column if not exists content_redacted_at timestamptz,
  alter column ciphertext drop not null,
  alter column iv drop not null,
  alter column tag drop not null;
alter table competition_decision_calls add column if not exists content_redacted_at timestamptz;

do $migration$
begin
  if not exists (select 1 from pg_constraint where conrelid='competition_decision_states'::regclass and conname='decision_states_retained_content') then
    alter table competition_decision_states add constraint decision_states_retained_content check (
      (content_redacted_at is null and ciphertext is not null and iv is not null and tag is not null)
      or (content_redacted_at is not null and ciphertext is null and iv is null and tag is null)
    );
  end if;
  if not exists (select 1 from pg_constraint where conrelid='competition_decision_runs'::regclass and conname='decision_runs_retained_content') then
    alter table competition_decision_runs add constraint decision_runs_retained_content check (
      (content_redacted_at is null and ciphertext is not null and iv is not null and tag is not null)
      or (content_redacted_at is not null and status='expired' and ciphertext is null and iv is null and tag is null)
    );
  end if;
  if not exists (select 1 from pg_constraint where conrelid='competition_decision_chat_requests'::regclass and conname='decision_chat_retained_content') then
    alter table competition_decision_chat_requests add constraint decision_chat_retained_content check (
      (content_redacted_at is null and ciphertext is not null and iv is not null and tag is not null)
      or (content_redacted_at is not null and ciphertext is null and iv is null and tag is null)
    );
  end if;
  if not exists (select 1 from pg_constraint where conrelid='competition_decision_calls'::regclass and conname='decision_calls_retained_content') then
    alter table competition_decision_calls add constraint decision_calls_retained_content check (
      content_redacted_at is null or (ciphertext is null and iv is null and tag is null)
    );
  end if;
end
$migration$;

create table if not exists saitu_retention_maintenance (
  task text primary key check (task='ai_consents'),
  completed_day date not null,
  updated_at timestamptz not null default now()
);
revoke all on table saitu_retention_maintenance from public;
