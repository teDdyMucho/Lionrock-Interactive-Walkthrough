-- Raise the per-file upload ceiling for walkthrough videos.
--
-- Migration 008 recreated the walkthrough-videos bucket without
-- `file_size_limit`, which reset it to the project default. This puts it back.
--
-- ----------------------------------------------------------------------------
-- MEASURED RESULT (2026-09-19): running this does NOT raise the limit.
--
-- Probing Storage directly, both anonymously and signed in as an admin:
--     50 MB -> accepted
--     55 MB -> 413, "The object exceeded the maximum allowed size"
--
-- So the ceiling is a PROJECT-WIDE per-file cap, not the bucket setting. That
-- cap overrides whatever a bucket asks for, is 50 MB on the free plan, and
-- cannot be changed with SQL — it lives in the dashboard under
-- Settings → Storage and raising it above 50 MB requires a paid plan.
--
-- This migration is kept because the bucket setting should still be correct
-- (it is what applies once the project cap is lifted), but running it alone
-- changes nothing that a user would notice.
-- ----------------------------------------------------------------------------

update storage.buckets
   set file_size_limit = 524288000          -- 500MB
 where id = 'walkthrough-videos';

-- What the bucket asks for. The effective limit is min(this, project cap).
select id,
       file_size_limit,
       (file_size_limit / 1024 / 1024) as bucket_limit_mb
  from storage.buckets
 where id = 'walkthrough-videos';
