-- Migration 001 — allow uploads without a login
--
-- Run this in the Supabase SQL editor AFTER schema.sql.
--
-- WHAT THIS DOES
-- schema.sql restricts writes to `authenticated` users, so the Upload button
-- failed with "new row violates row-level security policy". This widens the
-- write policies to `anon`, so the modal works with no sign-in.
--
-- ⚠️  TRADEOFF — READ THIS
-- The anon key ships in client-side JavaScript, so it is public by design.
-- Once this migration runs, ANYONE who finds the site URL can:
--   • upload video files into the walkthrough-videos bucket
--   • create/edit/delete rows in properties and property_videos
-- There is no rate limit and no audit trail of who uploaded what.
--
-- This is a deliberate choice for a demo / soft launch. Before making the site
-- widely public, run `002-require-login-to-upload.sql` to reverse it and add
-- Supabase Auth to the modal.


-- ---------------------------------------------------------------------------
-- Tables: let anon write
-- ---------------------------------------------------------------------------
drop policy if exists "authenticated write properties" on public.properties;
drop policy if exists "anon write properties"          on public.properties;
create policy "anon write properties"
  on public.properties for all
  to anon, authenticated
  using (true) with check (true);

drop policy if exists "authenticated write property_videos" on public.property_videos;
drop policy if exists "anon write property_videos"          on public.property_videos;
create policy "anon write property_videos"
  on public.property_videos for all
  to anon, authenticated
  using (true) with check (true);


-- ---------------------------------------------------------------------------
-- Storage: let anon upload / replace / delete in this bucket only
-- ---------------------------------------------------------------------------
-- Every policy is scoped to bucket_id = 'walkthrough-videos', so other buckets
-- in this project stay untouched.
drop policy if exists "authenticated upload walkthrough videos" on storage.objects;
drop policy if exists "anon upload walkthrough videos"          on storage.objects;
create policy "anon upload walkthrough videos"
  on storage.objects for insert
  to anon, authenticated
  with check (bucket_id = 'walkthrough-videos');

drop policy if exists "authenticated update walkthrough videos" on storage.objects;
drop policy if exists "anon update walkthrough videos"          on storage.objects;
create policy "anon update walkthrough videos"
  on storage.objects for update
  to anon, authenticated
  using (bucket_id = 'walkthrough-videos')
  with check (bucket_id = 'walkthrough-videos');

-- Needed because the modal upserts with `upsert: true` — replacing an existing
-- object requires delete permission as well as update.
drop policy if exists "authenticated delete walkthrough videos" on storage.objects;
drop policy if exists "anon delete walkthrough videos"          on storage.objects;
create policy "anon delete walkthrough videos"
  on storage.objects for delete
  to anon, authenticated
  using (bucket_id = 'walkthrough-videos');
