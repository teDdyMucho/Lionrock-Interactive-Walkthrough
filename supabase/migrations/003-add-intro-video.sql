-- Migration 003 — add an optional "Intro" clip
--
-- Run this in the Supabase SQL editor after 001.
--
-- WHY
-- The walkthrough plays an intro clip first (behind the loader, and as the clip
-- the timeline opens on / loops back to). Uploaded properties had no intro of
-- their own, so the first room doubled as one — which made Exterior play twice
-- before Living.
--
-- This adds 'intro' as an allowed area so a property can have its own intro
-- clip. It is OPTIONAL: leave the Intro slot empty and the walkthrough simply
-- starts on the first room, with no repeat.

alter table public.property_videos
  drop constraint if exists property_videos_area_check;

alter table public.property_videos
  add constraint property_videos_area_check check (area in (
    'intro',
    'exterior','living','dining','kitchen','bedroom-1','bathroom','bedroom-2'
  ));

-- Intro sorts before every room. Existing rooms keep sort_order 0..6, so the
-- intro uses -1 rather than renumbering rows that are already correct.
comment on column public.property_videos.sort_order is
  'Nav/timeline order. The intro clip uses -1 so it always precedes room 0.';
