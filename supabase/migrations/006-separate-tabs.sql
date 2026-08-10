-- Migration 006 — keep the two tabs' properties fully separate
--
-- Run this in the Supabase SQL editor after 005.
--
-- WHY
-- The Video Walkthrough and Interactive Walkthrough (Beta) tabs shared one
-- property list, so every property appeared in both — even if its clips were
-- only ever uploaded for one of them. Each property now belongs to exactly one
-- tab, and the gallery and admin both filter by it.
--
-- Existing properties are assigned to 'interactive', which is where they were
-- built and uploaded. Nothing disappears: they keep behaving as they do today,
-- and the Video tab simply starts empty until you add properties to it.

alter table public.properties
  add column if not exists mode text not null default 'interactive';

alter table public.properties
  drop constraint if exists properties_mode_check;

alter table public.properties
  add constraint properties_mode_check
  check (mode in ('interactive', 'video'));

comment on column public.properties.mode is
  'Which gallery tab this property belongs to: ''interactive'' (scroll-scrub, '
  'forward clips only) or ''video'' (click-driven, needs forward + reversed '
  'clips). A property appears in exactly one tab.';

-- `slug` is globally unique, so a Video and an Interactive property can't
-- accidentally share one and collide in storage. Scoping uniqueness to the mode
-- would let both tabs hold a "unit-9"; keeping it global is the safer default
-- since the storage path is derived from the slug alone.

create index if not exists properties_mode_idx on public.properties (mode);
