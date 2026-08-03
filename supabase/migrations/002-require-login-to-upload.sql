-- Migration 002 — REVERSE of 001: require a login to upload again
--
-- Run this when you're ready to close public uploads. It restores the strict
-- policies from schema.sql: reads stay open (the walkthrough needs them), but
-- writes require a signed-in Supabase user.
--
-- NOTE: after running this, the Upload button stops working until the modal
-- can sign a user in — nothing in the page does that yet. Add Supabase Auth
-- (Dashboard → Authentication → Users → invite yourself, then add a sign-in
-- step to the modal) at the same time, or the button will just report
-- "new row violates row-level security policy" again.


-- ---------------------------------------------------------------------------
-- Tables: authenticated writes only
-- ---------------------------------------------------------------------------
drop policy if exists "anon write properties"          on public.properties;
drop policy if exists "authenticated write properties" on public.properties;
create policy "authenticated write properties"
  on public.properties for all
  to authenticated
  using (true) with check (true);

drop policy if exists "anon write property_videos"          on public.property_videos;
drop policy if exists "authenticated write property_videos" on public.property_videos;
create policy "authenticated write property_videos"
  on public.property_videos for all
  to authenticated
  using (true) with check (true);


-- ---------------------------------------------------------------------------
-- Storage: authenticated writes only
-- ---------------------------------------------------------------------------
drop policy if exists "anon upload walkthrough videos"          on storage.objects;
drop policy if exists "authenticated upload walkthrough videos" on storage.objects;
create policy "authenticated upload walkthrough videos"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'walkthrough-videos');

drop policy if exists "anon update walkthrough videos"          on storage.objects;
drop policy if exists "authenticated update walkthrough videos" on storage.objects;
create policy "authenticated update walkthrough videos"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'walkthrough-videos')
  with check (bucket_id = 'walkthrough-videos');

drop policy if exists "anon delete walkthrough videos"          on storage.objects;
drop policy if exists "authenticated delete walkthrough videos" on storage.objects;
create policy "authenticated delete walkthrough videos"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'walkthrough-videos');
