-- Migration 005 — reversed clips for the Video Walkthrough tab
--
-- Run this in the Supabase SQL editor after 004.
--
-- WHY
-- No browser can play a <video> backwards. The Interactive walkthrough works
-- around it by seeking frame-by-frame, which is why reverse scrubbing is the
-- choppy part. The Video Walkthrough tab avoids the problem entirely by
-- playing a pre-rendered reversed copy forwards.
--
-- Each area therefore has two clips:
--   video_url   — forward  (already exists; used by both tabs)
--   reverse_url — reversed (new; used only by the Video Walkthrough tab)
--
-- Adding columns to the existing table rather than making a new one keeps a
-- single list of properties and areas behind both tabs: rename or reorder a
-- room once and both stay in sync.

alter table public.property_videos
  add column if not exists reverse_url  text,
  add column if not exists reverse_path text;

comment on column public.property_videos.reverse_url is
  'Public URL of the pre-rendered REVERSED clip. Played forwards when the viewer '
  'moves to an earlier room in the Video Walkthrough tab. Null = no reverse '
  'uploaded, so that room can only be entered going forwards.';

comment on column public.property_videos.reverse_path is
  'Object path of the reversed clip inside the bucket, kept so a replace can '
  'delete the old file.';
