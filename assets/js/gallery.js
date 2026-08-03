/* Renders the whole gallery grid from Supabase.
 *
 * There are no hardcoded cards — every property in the `properties` table that
 * has at least one uploaded video gets one, linking to
 * /walkthrough/?property=<slug>.
 *
 * Thumbnail videos are deliberately lazy: `preload="none"` plus an
 * IntersectionObserver, so opening the gallery doesn't start pulling several
 * multi-megabyte clips at once. A clip only loads when its card is hovered
 * (desktop) or scrolled into view (touch).
 */

(async function renderGallery() {
  const grid = document.getElementById('grid');
  const status = document.getElementById('gallery-status');
  if (!grid) return;

  const setStatus = (msg) => { if (status) status.textContent = msg || ''; };

  const cfg = window.SUPABASE_CONFIG || {};
  const ready =
    cfg.url && cfg.anonKey &&
    !cfg.url.includes('YOUR-PROJECT-REF') &&
    !cfg.anonKey.includes('YOUR-ANON');

  if (!ready) {
    setStatus('Supabase isn\'t configured — run `npm run config` after filling in .env.');
    return;
  }

  setStatus('Loading…');

  const db = window.supabase.createClient(cfg.url, cfg.anonKey);

  const { data, error } = await db
    .from('properties')
    .select('slug, title, address, property_videos(video_url, sort_order)')
    .order('created_at');

  if (error) {
    setStatus(`Couldn't load properties: ${error.message}`);
    return;
  }

  // Only properties with something to play.
  const playable = (data || [])
    .map((p) => ({
      ...p,
      clips: (p.property_videos || [])
        .filter((v) => v.video_url)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
    }))
    .filter((p) => p.clips.length);

  if (!playable.length) {
    setStatus('No walkthroughs yet — use the Upload button to add one.');
    return;
  }

  setStatus('');

  const frag = document.createDocumentFragment();
  playable.forEach((p) => frag.appendChild(buildCard(p, p.clips[0].video_url)));
  grid.appendChild(frag);

  wireLazyPreviews(grid);

  function buildCard(property, posterVideo) {
    const card = document.createElement('a');
    card.className = 'card';
    card.href = `/walkthrough/?property=${encodeURIComponent(property.slug)}`;

    const thumb = document.createElement('div');
    thumb.className = 'thumb';

    const video = document.createElement('video');
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    // Nothing is fetched until the card is actually near/under the pointer.
    video.preload = 'none';
    video.dataset.src = posterVideo;
    thumb.appendChild(video);

    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = property.title;

    const sub = document.createElement('div');
    sub.className = 'card-sub';
    sub.textContent = property.address || '';

    card.append(thumb, title, sub);
    return card;
  }
})();

/* Attaches the src only when it's worth paying for, then plays on hover. */
function wireLazyPreviews(grid) {
  const load = (video) => {
    if (!video.src && video.dataset.src) {
      video.src = video.dataset.src;
      video.preload = 'metadata';
    }
  };

  // Touch devices have no hover, so bring the first frame in when the card is
  // on screen — otherwise those cards would stay blank.
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      (entries, obs) => {
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          load(e.target.querySelector('video'));
          obs.unobserve(e.target);
        });
      },
      { rootMargin: '200px' }
    );
    grid.querySelectorAll('.card').forEach((c) => io.observe(c));
  } else {
    grid.querySelectorAll('.card video').forEach(load);
  }

  grid.querySelectorAll('.card').forEach((card) => {
    const video = card.querySelector('video');
    card.addEventListener('mouseenter', () => {
      load(video);
      video.play().catch(() => {});
    });
    card.addEventListener('mouseleave', () => {
      video.pause();
      video.currentTime = 0;
    });
  });
}
