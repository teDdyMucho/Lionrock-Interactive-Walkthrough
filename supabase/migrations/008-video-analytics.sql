-- Video Walkthrough — uploaded videos with per-video analytics.
-- Tracks viewers (with IP), shares, and a view log. Run in the Supabase SQL editor.

-- 1) The videos ------------------------------------------------------------
create table if not exists public.video_walkthroughs (
  id             uuid primary key default gen_random_uuid(),
  token          text not null unique,          -- shareable link id (?v=<token>)
  title          text not null,
  address        text,
  description    text,
  video_url      text not null,                 -- Supabase Storage public URL
  storage_path   text,
  thumbnail_url  text,
  creator        text,                          -- app user email
  view_count     integer not null default 0,    -- denormalized running total
  share_count    integer not null default 0,
  created_at     timestamptz not null default now()
);
create index if not exists idx_vw_token      on public.video_walkthroughs (token);
create index if not exists idx_vw_created_at on public.video_walkthroughs (created_at desc);

-- 2) View log (one row per view) ------------------------------------------
create table if not exists public.video_walkthrough_views (
  id           uuid primary key default gen_random_uuid(),
  video_id     uuid not null references public.video_walkthroughs (id) on delete cascade,
  token        text not null,
  ip_address   text,
  user_agent   text,
  referrer     text,
  city         text,
  region       text,
  country      text,
  viewed_at    timestamptz not null default now()
);
create index if not exists idx_vwv_video_id  on public.video_walkthrough_views (video_id);
create index if not exists idx_vwv_ip        on public.video_walkthrough_views (ip_address);
create index if not exists idx_vwv_viewed_at on public.video_walkthrough_views (viewed_at desc);

-- 3) Share log (one row per share action) ---------------------------------
create table if not exists public.video_walkthrough_shares (
  id           uuid primary key default gen_random_uuid(),
  video_id     uuid not null references public.video_walkthroughs (id) on delete cascade,
  token        text not null,
  channel      text,                            -- 'copy' | 'sms' | 'email' | ...
  shared_by    text,
  shared_at    timestamptz not null default now()
);
create index if not exists idx_vws_video_id on public.video_walkthrough_shares (video_id);

-- 4) Atomic counter helpers (called from the view-logging function) --------
create or replace function public.increment_video_view(p_video_id uuid)
returns void language sql as $$
  update public.video_walkthroughs set view_count = view_count + 1 where id = p_video_id;
$$;

create or replace function public.increment_video_share(p_video_id uuid)
returns void language sql as $$
  update public.video_walkthroughs set share_count = share_count + 1 where id = p_video_id;
$$;

-- 5) Row Level Security ----------------------------------------------------
alter table public.video_walkthroughs        enable row level security;
alter table public.video_walkthrough_views    enable row level security;
alter table public.video_walkthrough_shares   enable row level security;

-- Videos: anyone can read (public viewer) and the app can insert/update/delete.
drop policy if exists "vw read" on public.video_walkthroughs;
create policy "vw read" on public.video_walkthroughs for select to anon, authenticated using (true);
drop policy if exists "vw write" on public.video_walkthroughs;
create policy "vw write" on public.video_walkthroughs for all to anon, authenticated using (true) with check (true);

-- Views: insert from the public viewer; read for analytics.
drop policy if exists "vwv insert" on public.video_walkthrough_views;
create policy "vwv insert" on public.video_walkthrough_views for insert to anon, authenticated with check (true);
drop policy if exists "vwv read" on public.video_walkthrough_views;
create policy "vwv read" on public.video_walkthrough_views for select to anon, authenticated using (true);

-- Shares: insert + read.
drop policy if exists "vws insert" on public.video_walkthrough_shares;
create policy "vws insert" on public.video_walkthrough_shares for insert to anon, authenticated with check (true);
drop policy if exists "vws read" on public.video_walkthrough_shares;
create policy "vws read" on public.video_walkthrough_shares for select to anon, authenticated using (true);

-- 6) Storage bucket for the video files -----------------------------------
insert into storage.buckets (id, name, public)
values ('walkthrough-videos', 'walkthrough-videos', true)
on conflict (id) do update set public = true;

drop policy if exists "walkthrough-videos upload" on storage.objects;
create policy "walkthrough-videos upload" on storage.objects
  for insert to anon, authenticated with check (bucket_id = 'walkthrough-videos');
drop policy if exists "walkthrough-videos read" on storage.objects;
create policy "walkthrough-videos read" on storage.objects
  for select to anon, authenticated using (bucket_id = 'walkthrough-videos');
