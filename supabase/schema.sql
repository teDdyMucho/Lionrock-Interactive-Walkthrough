-- Lion Rock — walkthrough upload schema
--
-- Run this once in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- It is idempotent: re-running it will not drop data or error on existing objects.
--
-- What it creates:
--   1. properties        — one row per property/unit shown in the gallery
--   2. property_videos   — one row per room clip; `video_url` holds the public
--                          Storage URL produced by the upload modal
--   3. walkthrough-videos — a public Storage bucket the browser uploads into
--   4. RLS policies      — public read, authenticated write


-- ---------------------------------------------------------------------------
-- 1. Properties
-- ---------------------------------------------------------------------------
create table if not exists public.properties (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,          -- e.g. '2209-Branch-Ave-Anoka-MN-55303'
  title       text not null,                 -- e.g. 'Unit 9'
  address     text,                          -- e.g. '2209 Branch Ave Anoka, MN 55303'
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table  public.properties      is 'One row per property/unit in the walkthrough gallery.';
comment on column public.properties.slug is 'URL-safe folder name; matches the project folder in the repo.';


-- ---------------------------------------------------------------------------
-- 2. Room videos — the 7 upload areas
-- ---------------------------------------------------------------------------
-- `area` is constrained to the 7 rooms the upload modal exposes. Adding an
-- eighth room later = add it to this check constraint and to ROOM_AREAS in
-- assets/js/upload.js.
create table if not exists public.property_videos (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references public.properties (id) on delete cascade,
  area         text not null check (area in (
                 'exterior','living','dining','kitchen','bedroom-1','bathroom','bedroom-2'
               )),
  label        text not null,                -- display name, e.g. 'Bedroom 1'
  video_url    text,                         -- public Storage URL of the uploaded clip
  storage_path text,                         -- path inside the bucket, for deletes/replaces
  sort_order   int  not null default 0,      -- nav ordering on the walkthrough page
  updated_at   timestamptz not null default now(),

  -- one clip per area per property, so re-uploading an area replaces it
  unique (property_id, area)
);

comment on column public.property_videos.video_url    is 'Public URL in the walkthrough-videos bucket; read by the walkthrough page.';
comment on column public.property_videos.storage_path is 'Object path inside the bucket, kept so a replace can delete the old file.';

create index if not exists property_videos_property_id_idx
  on public.property_videos (property_id, sort_order);


-- ---------------------------------------------------------------------------
-- 3. keep updated_at honest
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists properties_touch_updated_at on public.properties;
create trigger properties_touch_updated_at
  before update on public.properties
  for each row execute function public.touch_updated_at();

drop trigger if exists property_videos_touch_updated_at on public.property_videos;
create trigger property_videos_touch_updated_at
  before update on public.property_videos
  for each row execute function public.touch_updated_at();


-- ---------------------------------------------------------------------------
-- 4. Storage bucket for the video files
-- ---------------------------------------------------------------------------
-- public = true so the walkthrough page can stream clips without signed URLs.
-- 500MB per-file ceiling; drop `file_size_limit` to fall back to the project default.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'walkthrough-videos',
  'walkthrough-videos',
  true,
  524288000,
  array['video/mp4','video/quicktime','video/webm']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;


-- ---------------------------------------------------------------------------
-- 5. Row Level Security
-- ---------------------------------------------------------------------------
-- Anyone may READ (the public walkthrough needs it). Only signed-in users may
-- write — that is the permission boundary for uploading.
--
-- ⚠️  This project currently runs with uploads OPEN TO EVERYONE. That is set by
-- supabase/migrations/001-open-uploads-to-anon.sql, which must be run AFTER
-- this file. If you re-run schema.sql on an existing project it will reset the
-- write policies back to authenticated-only and the Upload button will stop
-- working — re-run migration 001 afterwards to restore it.
alter table public.properties      enable row level security;
alter table public.property_videos enable row level security;

drop policy if exists "public read properties" on public.properties;
create policy "public read properties"
  on public.properties for select
  to anon, authenticated
  using (true);

drop policy if exists "authenticated write properties" on public.properties;
create policy "authenticated write properties"
  on public.properties for all
  to authenticated
  using (true) with check (true);

drop policy if exists "public read property_videos" on public.property_videos;
create policy "public read property_videos"
  on public.property_videos for select
  to anon, authenticated
  using (true);

drop policy if exists "authenticated write property_videos" on public.property_videos;
create policy "authenticated write property_videos"
  on public.property_videos for all
  to authenticated
  using (true) with check (true);


-- Storage object policies for this bucket
drop policy if exists "public read walkthrough videos" on storage.objects;
create policy "public read walkthrough videos"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'walkthrough-videos');

drop policy if exists "authenticated upload walkthrough videos" on storage.objects;
create policy "authenticated upload walkthrough videos"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'walkthrough-videos');

drop policy if exists "authenticated update walkthrough videos" on storage.objects;
create policy "authenticated update walkthrough videos"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'walkthrough-videos')
  with check (bucket_id = 'walkthrough-videos');

drop policy if exists "authenticated delete walkthrough videos" on storage.objects;
create policy "authenticated delete walkthrough videos"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'walkthrough-videos');


-- ---------------------------------------------------------------------------
-- 6. Seed the property that already exists in the repo
-- ---------------------------------------------------------------------------
insert into public.properties (slug, title, address)
values (
  '2209-Branch-Ave-Anoka-MN-55303',
  'Unit 9',
  '2209 Branch Ave Anoka, MN 55303'
)
on conflict (slug) do nothing;
