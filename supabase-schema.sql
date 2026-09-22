-- Yilan Rental Helper v2.2 cloud state
create table if not exists public.yilan_app_state (
  id text primary key default 'main',
  revision bigint not null default 1,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

create table if not exists public.yilan_app_state_history (
  id bigint generated always as identity primary key,
  state_id text not null,
  revision bigint not null,
  payload jsonb not null,
  changed_at timestamptz not null default now(),
  changed_by text
);

alter table public.yilan_app_state enable row level security;
alter table public.yilan_app_state_history enable row level security;

-- No anon/authenticated policies by design.
-- Browser access goes through the Edge Function, which validates a family PIN.
