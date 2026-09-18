-- Raise the per-file upload ceiling for walkthrough videos.
--
-- Migration 008 recreated the bucket without `file_size_limit`, which reset it
-- to the project default. This puts it back to 500MB.
--
-- IMPORTANT: this alone may not be enough. Supabase also enforces a
-- PROJECT-WIDE per-file cap that overrides whatever a bucket asks for. On the
-- free plan that cap is 50MB, and no SQL can raise it — it lives in the
-- dashboard under Settings → Storage ("Upload file size limit"), and going
-- above 50MB needs a paid plan.
--
-- After running this, check the result below. If `effective_limit_mb` still
-- reads 50, the project cap is what's holding it down, not the bucket.

update storage.buckets
   set file_size_limit = 524288000          -- 500MB
 where id = 'walkthrough-videos';

-- What the bucket now asks for.
select id,
       file_size_limit,
       (file_size_limit / 1024 / 1024) as bucket_limit_mb
  from storage.buckets
 where id = 'walkthrough-videos';
