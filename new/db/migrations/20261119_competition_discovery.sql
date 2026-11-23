-- Independent discovery sessions; existing recommendation grants and spend are untouched.
create table if not exists competition_discovery_sessions (
  session_id uuid primary key,
  creation_key text not null unique check (creation_key ~ '^[a-f0-9]{64}$'),
  input_sha256 text not null check (input_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null default 'active' check (status in ('active','deleted','expired')),
  ciphertext bytea, iv bytea, tag bytea,
  clarification_status text not null default 'pending' check (clarification_status in ('pending','running','complete','failed')),
  clarification_request_key text,
  clarification_owner text,
  clarification_fence bigint not null default 0,
  clarification_lease_expires_at timestamptz,
  clarification_deadline_at timestamptz,
  current_run_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check ((status='active' and ciphertext is not null and iv is not null and tag is not null)
    or (status<>'active' and ciphertext is null and iv is null and tag is null))
);
create table if not exists competition_discovery_runs (
  run_id uuid primary key,
  session_id uuid not null references competition_discovery_sessions(session_id),
  submission_key text not null unique check (submission_key ~ '^[a-f0-9]{64}$'),
  input_sha256 text not null check (input_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('queued','running','complete','failed','cancelled','superseded','deleted','expired')),
  ciphertext bytea, iv bytea, tag bytea,
  next_event_seq bigint not null default 0 check (next_event_seq>=0),
  lease_owner text, lease_fence bigint not null default 0, lease_expires_at timestamptz,
  submitted_at timestamptz not null, deadline_at timestamptz not null, expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  check (deadline_at>submitted_at),
  check ((status not in ('deleted','expired') and ciphertext is not null and iv is not null and tag is not null)
    or (status in ('deleted','expired') and ciphertext is null and iv is null and tag is null))
);
create index if not exists competition_discovery_runs_queue on competition_discovery_runs(status,submitted_at);
create index if not exists competition_discovery_sessions_expiry on competition_discovery_sessions(expires_at) where status='active';
create table if not exists competition_discovery_events (
  run_id uuid not null references competition_discovery_runs(run_id),
  seq bigint not null check (seq>0),
  ciphertext bytea, iv bytea, tag bytea,
  redacted boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (run_id,seq),
  check ((redacted=false and ciphertext is not null and iv is not null and tag is not null)
    or (redacted=true and ciphertext is null and iv is null and tag is null))
);
revoke all on competition_discovery_sessions,competition_discovery_runs,competition_discovery_events from public;
