-- Migration 004 — allow custom, renameable areas
--
-- Run this in the Supabase SQL editor after 003.
--
-- WHY
-- `area` was locked to a fixed list by a check constraint, so you couldn't add
-- a room the list didn't already name (Garage, Balcony, Office…). The 8 defaults
-- stay exactly as they are — this just stops the database from rejecting
-- anything else.
--
-- `label` is what the nav actually displays and was always free text, so
-- renaming a room needs no schema change. This migration is only about ADDING
-- areas beyond the fixed set.
--
-- Safe to run on existing data: no rows are modified, only the constraint is
-- relaxed.

-- 1. Drop the fixed whitelist.
alter table public.property_videos
  drop constraint if exists property_videos_area_check;

-- 2. Keep a real constraint — `area` is used to build the storage path, so it
--    still has to be a non-empty, URL-safe slug. This validates shape rather
--    than membership.
alter table public.property_videos
  add constraint property_videos_area_check
  check (area ~ '^[a-z0-9][a-z0-9-]{0,47}$');

comment on column public.property_videos.area is
  'URL-safe slug identifying the clip within a property (used in the storage path). '
  '''intro'' is special-cased by the player; everything else is a room. '
  'Free-form since migration 004 — the display name lives in `label`.';

-- 3. sort_order drives both nav order and the timeline, so it should be
--    explicit rather than relying on insert order.
comment on column public.property_videos.sort_order is
  'Nav/timeline order. The intro clip uses -1 so it always precedes room 0.';
