/* The public viewer for one video: /v/?v=<token>
 *
 * Loads the video by its share token and logs a view.
 *
 * The view is logged through POST /api/video-view rather than straight into
 * Supabase from here, because the browser can't see its own public IP and a
 * client-supplied one would be forgeable. The serverless function reads the
 * real address off the request headers.
 */

(function () {
  const $ = (id) => document.getElementById(id);

  const cfg = window.SUPABASE_CONFIG || {};
  const configured =
    cfg.url && cfg.anonKey &&
    !cfg.url.includes('YOUR-PROJECT-REF') &&
    !cfg.anonKey.includes('YOUR-ANON');

  const token = new URLSearchParams(location.search).get('v');

  const setStatus = (msg) => { $('status').textContent = msg || ''; };

  if (!token) {
    setStatus('No video specified. Check the link you were sent.');
    return;
  }

  if (!configured) {
    setStatus('Supabase isn\'t configured on this deployment.');
    return;
  }

  const db = window.supabase.createClient(cfg.url, cfg.anonKey);

  load();

  async function load() {
    const { data, error } = await db
      .from('video_walkthroughs')
      .select('id, token, title, address, description, video_url')
      .eq('token', token)
      .maybeSingle();

    if (error) {
      setStatus(
        /video_walkthroughs/.test(error.message)
          ? 'This deployment is missing migration 008 — run it in the Supabase SQL editor.'
          : `Couldn't load this video: ${error.message}`
      );
      return;
    }

    if (!data) {
      setStatus('This video no longer exists, or the link is wrong.');
      return;
    }

    setStatus('');
    $('content').hidden = false;

    document.title = `${data.title} — Lion Rock`;
    $('title').textContent = data.title;
    $('address').textContent = data.address || '';
    $('description').textContent = data.description || '';
    $('player').src = data.video_url;

    logView();
    wireShare(data);
  }

  /* One view per page load. Fired straight away rather than on play, so a
     viewer who opens the link and reads the details still counts — the metric
     is "someone opened this link". */
  function logView() {
    const payload = JSON.stringify({ token, referrer: document.referrer || null });

    // sendBeacon survives a viewer who navigates away immediately; fetch is the
    // fallback where it isn't available.
    const sent =
      navigator.sendBeacon &&
      navigator.sendBeacon(
        '/api/video-view',
        new Blob([payload], { type: 'application/json' })
      );

    if (!sent) {
      fetch('/api/video-view', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
      }).catch(() => { /* never block the viewer on analytics */ });
    }
  }

  function wireShare(video) {
    const btn = $('share');
    const label = $('share-label');
    if (!btn) return;

    btn.addEventListener('click', async () => {
      const url = location.href;

      if (navigator.share) {
        try {
          await navigator.share({ title: `${video.title} — Lion Rock`, url });
          logShare(video, 'native');
          return;
        } catch (err) {
          if (err && err.name === 'AbortError') return;  // dismissed, not shared
        }
      }

      try {
        await navigator.clipboard.writeText(url);
        label.textContent = 'Link copied';
        setTimeout(() => { label.textContent = 'Share'; }, 1800);
        logShare(video, 'copy');
      } catch {
        window.prompt('Copy this link:', url);
        logShare(video, 'prompt');
      }
    });
  }

  async function logShare(video, channel) {
    // Best-effort, same as the gallery: never let analytics break the action.
    try {
      await db.from('video_walkthrough_shares').insert({
        video_id: video.id,
        token: video.token,
        channel,
      });
      await db.rpc('increment_video_share', { p_video_id: video.id });
    } catch { /* ignore */ }
  }
})();
