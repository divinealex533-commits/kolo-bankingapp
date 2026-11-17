-- Kolo core banking schema (Phase 1)
-- All money is stored in kobo (bigint). ₦1 = 100 kobo. Never use floats for money.
-- Balances change ONLY through the security-definer functions at the bottom of this file,
-- which are callable by the service role (edge functions) and never by the app directly.

create extension if not exists pgcrypto;

-- ───────────────────────── types ─────────────────────────
create type public.kyc_status as enum ('none', 'pending', 'verified', 'rejected');
create type public.txn_status as enum ('pending', 'successful', 'failed', 'reversed');
create type public.txn_direction as enum ('debit', 'credit');

-- ───────────────────────── account tiers ─────────────────────────
-- CBN tiered-KYC limits. CONFIRM the current figures with 9PSB before launch; they change.
create table public.tiers (
  tier smallint primary key,
  name text not null,
  single_kobo bigint not null,        -- max per transaction
  daily_kobo bigint not null,         -- max total debits per day
  max_balance_kobo bigint             -- null = no cap
);
insert into public.tiers values
  (0, 'Unverified', 0, 0, 0),
  (1, 'Tier 1', 5000000, 5000000, 30000000),            -- ₦50k / ₦50k / ₦300k
  (2, 'Tier 2', 20000000, 20000000, 50000000),          -- ₦200k / ₦200k / ₦500k
  (3, 'Tier 3', 500000000, 500000000, null);            -- ₦5m / ₦5m / no cap

-- ───────────────────────── people ─────────────────────────
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  first_name text not null default '',
  last_name text not null default '',
  phone text unique,
  tag text unique check (tag ~ '^[a-z0-9_.]{3,20}$'),
  tier smallint not null default 0 references public.tiers (tier),
  kyc_status public.kyc_status not null default 'none',
  bvn_hash text unique,               -- peppered hash: blocks one BVN opening many accounts
  bvn_last4 text,
  nin_last4 text,
  dob date,
  is_admin boolean not null default false,
  frozen boolean not null default false,
  daily_limit_kobo bigint check (daily_limit_kobo is null or daily_limit_kobo >= 0),
  otp_large boolean not null default true,
  pidgin boolean not null default false,
  created_at timestamptz not null default now()
);

-- PIN material lives in its own table with NO client policies at all.
create table public.security_secrets (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  pin_hash text,
  pin_salt text,
  pin_iterations int,
  pin_fails int not null default 0,
  pin_locked_until timestamptz,
  pin_set_at timestamptz
);

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  device_id text not null,
  name text not null default 'Unknown device',
  trusted boolean not null default false,
  last_seen timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (user_id, device_id)
);

-- ───────────────────────── money ─────────────────────────
create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references public.profiles (id) on delete restrict,
  kind text not null default 'customer' check (kind in ('customer', 'fees', 'suspense')),
  account_number text unique,
  account_name text,
  bank_name text,
  provider text not null default 'mock',
  provider_ref text,
  balance_kobo bigint not null default 0 check (balance_kobo >= 0),
  status text not null default 'active' check (status in ('active', 'frozen', 'closed')),
  created_at timestamptz not null default now(),
  check ((kind = 'customer') = (user_id is not null))
);
-- Internal accounts: transfer fees earned, and money in flight to other banks.
insert into public.accounts (kind, account_name) values ('fees', 'Kolo fee income'), ('suspense', 'Outbound transfers in flight');

create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  user_id uuid references public.profiles (id),
  account_id uuid not null references public.accounts (id),
  direction public.txn_direction not null,
  category text not null,             -- bank_transfer | kolo_transfer | deposit | reversal | airtime | bill | savings | ...
  amount_kobo bigint not null check (amount_kobo > 0),
  fee_kobo bigint not null default 0 check (fee_kobo >= 0),
  status public.txn_status not null default 'pending',
  counterparty jsonb not null default '{}',
  narration text,
  provider_ref text unique,
  idempotency_key text,
  failure_reason text,
  balance_after_kobo bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index transactions_idem on public.transactions (user_id, idempotency_key) where idempotency_key is not null;
create index transactions_account_time on public.transactions (account_id, created_at desc);
create index transactions_pending on public.transactions (status, created_at) where status = 'pending';

-- Append-only record of every balance movement. Sum of entries per account = its balance.
create table public.ledger_entries (
  id bigserial primary key,
  txn_id uuid not null references public.transactions (id),
  account_id uuid not null references public.accounts (id),
  amount_kobo bigint not null,        -- positive = credit, negative = debit
  balance_after_kobo bigint not null,
  created_at timestamptz not null default now()
);
create index ledger_account on public.ledger_entries (account_id, id);

create function public.block_ledger_changes() returns trigger language plpgsql as $$
begin raise exception 'ledger_entries is append-only'; end $$;
create trigger ledger_no_update before update or delete on public.ledger_entries
  for each row execute function public.block_ledger_changes();

create table public.beneficiaries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  account_name text not null,
  account_number text not null,
  bank_code text not null,
  bank_name text not null,
  created_at timestamptz not null default now(),
  unique (user_id, bank_code, account_number)
);

-- ───────────────────────── security plumbing ─────────────────────────
create table public.otp_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  purpose text not null,
  code_hash text not null,
  attempts int not null default 0,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index otp_user on public.otp_codes (user_id, created_at desc);

create table public.rate_events (
  id bigserial primary key,
  user_id uuid not null,
  action text not null,
  created_at timestamptz not null default now()
);
create index rate_events_lookup on public.rate_events (user_id, action, created_at desc);

create table public.audit_log (
  id bigserial primary key,
  user_id uuid,
  actor text not null default 'user', -- user | system | admin:<uuid>
  action text not null,
  meta jsonb not null default '{}',
  ip text,
  created_at timestamptz not null default now()
);
create index audit_user on public.audit_log (user_id, created_at desc);

create table public.notifications (
  id bigserial primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  title text not null,
  body text not null default '',
  kind text not null default 'info',  -- credit | debit | security | info
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index notifications_user on public.notifications (user_id, created_at desc);

create table public.webhook_events (
  id bigserial primary key,
  provider text not null,
  event_id text not null,
  payload jsonb not null,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (provider, event_id)
);

-- ───────────────────────── new user → profile ─────────────────────────
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, phone) values (new.id, new.phone) on conflict do nothing;
  insert into public.security_secrets (user_id) values (new.id) on conflict do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ───────────────────────── row level security ─────────────────────────
alter table public.tiers enable row level security;
alter table public.profiles enable row level security;
alter table public.security_secrets enable row level security;
alter table public.devices enable row level security;
alter table public.accounts enable row level security;
alter table public.transactions enable row level security;
alter table public.ledger_entries enable row level security;
alter table public.beneficiaries enable row level security;
alter table public.otp_codes enable row level security;
alter table public.rate_events enable row level security;
alter table public.audit_log enable row level security;
alter table public.notifications enable row level security;
alter table public.webhook_events enable row level security;

-- The app may READ its own data. Every write that matters goes through edge functions.
create policy "tiers readable" on public.tiers for select to authenticated using (true);
create policy "own profile" on public.profiles for select to authenticated using (id = auth.uid());
create policy "own devices" on public.devices for select to authenticated using (user_id = auth.uid());
create policy "own account" on public.accounts for select to authenticated using (user_id = auth.uid());
create policy "own transactions" on public.transactions for select to authenticated using (user_id = auth.uid());
create policy "own beneficiaries read" on public.beneficiaries for select to authenticated using (user_id = auth.uid());
create policy "own beneficiaries delete" on public.beneficiaries for delete to authenticated using (user_id = auth.uid());
create policy "own notifications read" on public.notifications for select to authenticated using (user_id = auth.uid());
create policy "own notifications mark read" on public.notifications for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
-- security_secrets, otp_codes, rate_events, audit_log, ledger_entries, webhook_events: no client policies (service role only).

-- Only the `read` flag on notifications is client-writable.
revoke update on public.notifications from authenticated;
grant update (read) on public.notifications to authenticated;

-- ───────────────────────── money functions ─────────────────────────
-- Internal helper: move money on one account and write the ledger line. Locks the row.
create function public.post_entry(p_txn uuid, p_account uuid, p_amount bigint) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_bal bigint;
begin
  update accounts set balance_kobo = balance_kobo + p_amount where id = p_account returning balance_kobo into v_bal;
  if v_bal is null then raise exception 'account_not_found'; end if;
  insert into ledger_entries (txn_id, account_id, amount_kobo, balance_after_kobo) values (p_txn, p_account, p_amount, v_bal);
  return v_bal;
end $$;

create function public.internal_account(p_kind text) returns uuid
language sql stable security definer set search_path = public as $$
  select id from accounts where kind = p_kind limit 1
$$;

-- Total debits today (Lagos time) that count against limits.
create function public.spent_today(p_user uuid) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(sum(amount_kobo + fee_kobo), 0)::bigint
  from transactions
  where user_id = p_user and direction = 'debit'
    and status in ('pending', 'successful')
    and category not in ('savings')
    and created_at >= (date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos')
$$;

-- Simple sliding-window rate limit. Returns true if allowed (and records the hit).
create function public.rate_hit(p_user uuid, p_action text, p_max int, p_window interval) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  select count(*) into n from rate_events where user_id = p_user and action = p_action and created_at > now() - p_window;
  if n >= p_max then return false; end if;
  insert into rate_events (user_id, action) values (p_user, p_action);
  return true;
end $$;

-- Step 1 of an outbound transfer: take the money (amount + fee) from the customer and park it.
-- Idempotent: the same idempotency key returns the original transaction.
create function public.begin_debit(
  p_user uuid, p_amount bigint, p_fee bigint, p_category text, p_reference text,
  p_counterparty jsonb, p_narration text, p_idem text
) returns public.transactions
language plpgsql security definer set search_path = public as $$
declare a accounts; t transactions; v_bal bigint;
begin
  if p_amount <= 0 or p_fee < 0 then raise exception 'invalid_amount'; end if;
  if p_idem is not null then
    select * into t from transactions where user_id = p_user and idempotency_key = p_idem;
    if found then return t; end if;
  end if;
  select * into a from accounts where user_id = p_user and kind = 'customer' for update;
  if not found then raise exception 'no_account'; end if;
  if a.status <> 'active' then raise exception 'account_frozen'; end if;
  if a.balance_kobo < p_amount + p_fee then raise exception 'insufficient_funds'; end if;

  insert into transactions (reference, user_id, account_id, direction, category, amount_kobo, fee_kobo, status, counterparty, narration, idempotency_key)
  values (p_reference, p_user, a.id, 'debit', p_category, p_amount, p_fee, 'pending', coalesce(p_counterparty, '{}'), p_narration, p_idem)
  returning * into t;

  v_bal := post_entry(t.id, a.id, -(p_amount + p_fee));
  perform post_entry(t.id, internal_account('suspense'), p_amount);
  if p_fee > 0 then perform post_entry(t.id, internal_account('fees'), p_fee); end if;

  update transactions set balance_after_kobo = v_bal where id = t.id returning * into t;
  return t;
end $$;

-- Step 2a: the bank confirmed the transfer. Money leaves suspense for good.
create function public.settle_debit(p_txn uuid, p_provider_ref text) returns public.transactions
language plpgsql security definer set search_path = public as $$
declare t transactions;
begin
  select * into t from transactions where id = p_txn for update;
  if not found then raise exception 'txn_not_found'; end if;
  if t.status <> 'pending' then return t; end if;  -- already settled or reversed
  perform post_entry(t.id, internal_account('suspense'), -t.amount_kobo);
  update transactions set status = 'successful', provider_ref = coalesce(p_provider_ref, provider_ref), updated_at = now()
  where id = t.id returning * into t;
  return t;
end $$;

-- Step 2b: the bank rejected it. Give everything back, fee included.
create function public.reverse_debit(p_txn uuid, p_reason text) returns public.transactions
language plpgsql security definer set search_path = public as $$
declare t transactions; v_bal bigint;
begin
  select * into t from transactions where id = p_txn for update;
  if not found then raise exception 'txn_not_found'; end if;
  if t.status <> 'pending' then return t; end if;
  perform post_entry(t.id, internal_account('suspense'), -t.amount_kobo);
  if t.fee_kobo > 0 then perform post_entry(t.id, internal_account('fees'), -t.fee_kobo); end if;
  v_bal := post_entry(t.id, t.account_id, t.amount_kobo + t.fee_kobo);
  update transactions set status = 'reversed', failure_reason = p_reason, balance_after_kobo = v_bal, updated_at = now()
  where id = t.id returning * into t;
  return t;
end $$;

-- Money arriving from another bank (called by the bank webhook). Idempotent on provider_ref.
create function public.credit_deposit(
  p_account_number text, p_amount bigint, p_provider_ref text, p_counterparty jsonb, p_narration text
) returns public.transactions
language plpgsql security definer set search_path = public as $$
declare a accounts; t transactions; v_bal bigint;
begin
  if p_amount <= 0 then raise exception 'invalid_amount'; end if;
  select * into t from transactions where provider_ref = p_provider_ref;
  if found then return t; end if;
  select * into a from accounts where account_number = p_account_number and kind = 'customer' for update;
  if not found then raise exception 'account_not_found'; end if;
  insert into transactions (reference, user_id, account_id, direction, category, amount_kobo, status, counterparty, narration, provider_ref)
  values ('KLD' || replace(gen_random_uuid()::text, '-', ''), a.user_id, a.id, 'credit', 'deposit', p_amount, 'successful', coalesce(p_counterparty, '{}'), p_narration, p_provider_ref)
  returning * into t;
  v_bal := post_entry(t.id, a.id, p_amount);
  update transactions set balance_after_kobo = v_bal where id = t.id returning * into t;
  return t;
end $$;

-- Kolo → Kolo transfer. Both sides move in one database transaction, so it can't half-happen.
create function public.internal_transfer(
  p_from uuid, p_to uuid, p_amount bigint, p_reference text, p_narration text, p_idem text
) returns public.transactions
language plpgsql security definer set search_path = public as $$
declare fa accounts; ta accounts; t transactions; c transactions; v_bal bigint; fp profiles; tp profiles;
begin
  if p_amount <= 0 then raise exception 'invalid_amount'; end if;
  if p_from = p_to then raise exception 'same_account'; end if;
  if p_idem is not null then
    select * into t from transactions where user_id = p_from and idempotency_key = p_idem;
    if found then return t; end if;
  end if;
  -- lock both accounts in a fixed order to avoid deadlocks
  perform 1 from accounts where user_id in (p_from, p_to) and kind = 'customer' order by id for update;
  select * into fa from accounts where user_id = p_from and kind = 'customer';
  select * into ta from accounts where user_id = p_to and kind = 'customer';
  if fa.id is null or ta.id is null then raise exception 'no_account'; end if;
  if fa.status <> 'active' then raise exception 'account_frozen'; end if;
  if ta.status = 'closed' then raise exception 'recipient_unavailable'; end if;
  if fa.balance_kobo < p_amount then raise exception 'insufficient_funds'; end if;
  select * into fp from profiles where id = p_from;
  select * into tp from profiles where id = p_to;

  insert into transactions (reference, user_id, account_id, direction, category, amount_kobo, status, counterparty, narration, idempotency_key)
  values (p_reference, p_from, fa.id, 'debit', 'kolo_transfer', p_amount, 'successful',
          jsonb_build_object('name', tp.first_name || ' ' || tp.last_name, 'tag', tp.tag), p_narration, p_idem)
  returning * into t;
  v_bal := post_entry(t.id, fa.id, -p_amount);
  update transactions set balance_after_kobo = v_bal where id = t.id returning * into t;

  insert into transactions (reference, user_id, account_id, direction, category, amount_kobo, status, counterparty, narration)
  values (p_reference || '-C', p_to, ta.id, 'credit', 'kolo_transfer', p_amount, 'successful',
          jsonb_build_object('name', fp.first_name || ' ' || fp.last_name, 'tag', fp.tag), p_narration)
  returning * into c;
  v_bal := post_entry(c.id, ta.id, p_amount);
  update transactions set balance_after_kobo = v_bal where id = c.id;
  return t;
end $$;

-- Lock everything down: only the service role (edge functions, admin server) may call these.
do $$
declare f text;
begin
  foreach f in array array[
    'post_entry(uuid,uuid,bigint)', 'internal_account(text)', 'spent_today(uuid)', 'rate_hit(uuid,text,integer,interval)',
    'begin_debit(uuid,bigint,bigint,text,text,jsonb,text,text)', 'settle_debit(uuid,text)', 'reverse_debit(uuid,text)',
    'credit_deposit(text,bigint,text,jsonb,text)', 'internal_transfer(uuid,uuid,bigint,text,text,text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- Health check for admins: every account's balance must equal the sum of its ledger entries.
create view public.ledger_mismatches as
  select a.id, a.kind, a.account_number, a.balance_kobo, coalesce(sum(l.amount_kobo), 0) as ledger_sum
  from public.accounts a left join public.ledger_entries l on l.account_id = a.id
  group by a.id
  having a.balance_kobo <> coalesce(sum(l.amount_kobo), 0);
revoke all on public.ledger_mismatches from public, anon, authenticated;
