-- Migration 007 — generated API keys with expiry
--
-- Run this in the Supabase SQL editor after 006.
--
-- WHY
-- The API was guarded by one shared key in an environment variable. That works,
-- but it can't be issued per consumer, can't expire, and rotating it breaks
-- everyone at once. This lets an admin mint a key from /manage/api/, choose how
-- long it lives, and revoke a single one without touching the others.
--
-- SECURITY
-- Only a SHA-256 hash of each key is stored, never the key itself — the same
-- reason passwords are hashed. A leaked database therefore can't be used to
-- call the API. The plaintext is shown once, at creation, and never again.

create table if not exists public.api_keys (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,                    -- what this key is for
  key_hash    text not null unique,             -- sha256(key), hex
  key_prefix  text not null,                    -- first 8 chars, to identify it in a list
  expires_at  timestamptz,                      -- null = never expires
  created_at  timestamptz not null default now(),
  created_by  text,                             -- admin email that minted it
  last_used_at timestamptz,                     -- updated on each successful call
  revoked_at  timestamptz                       -- set instead of deleting, to keep the audit trail
);

comment on table  public.api_keys            is 'Keys for GET /api/walkthroughs. Only hashes are stored.';
comment on column public.api_keys.key_hash   is 'SHA-256 of the key. The plaintext is shown once at creation and never stored.';
comment on column public.api_keys.key_prefix is 'First 8 characters, so a key can be recognised in a list without revealing it.';
comment on column public.api_keys.expires_at is 'When the key stops working. NULL means it never expires.';
comment on column public.api_keys.revoked_at is 'Set to revoke. Kept rather than deleted so the history survives.';

create index if not exists api_keys_hash_idx on public.api_keys (key_hash);


-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
-- The API validates keys server-side with the service-role key (or the anon key
-- for the read), so the browser never needs to see a hash. Signed-in admins may
-- list and manage keys; anonymous visitors get nothing at all.
alter table public.api_keys enable row level security;

drop policy if exists "admins read api_keys"   on public.api_keys;
drop policy if exists "admins write api_keys"  on public.api_keys;
drop policy if exists "verify api_keys"        on public.api_keys;

-- Signed-in admins: full management from the docs page.
create policy "admins write api_keys"
  on public.api_keys for all
  to authenticated
  using (true) with check (true);

-- The endpoint itself runs server-side and must be able to look a hash up.
-- Reading a hash is useless without the plaintext, so this is safe to allow.
create policy "verify api_keys"
  on public.api_keys for select
  to anon, authenticated
  using (true);
