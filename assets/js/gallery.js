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

/* Which player the cards link to. Remembered so the choice survives a reload
   and a trip into a walkthrough and back. */
const MODE_KEY = 'lionrock-walkthrough-mode';

function currentMode() {
  try {
    return localStorage.getItem(MODE_KEY) === 'video' ? 'video' : 'interactive';
  } catch {
    return 'interactive';
  }
}

function walkthroughHref(slug) {
  const base = currentMode() === 'video' ? '/video/' : '/walkthrough/';
  return `${base}?property=${encodeURIComponent(slug)}`;
}

async function renderGallery() {
  const grid = document.getElementById('grid');
  const status = document.getElementById('gallery-status');
  if (!grid) return;

  grid.innerHTML = '';   // switching tabs replaces the whole list

  const setStatus = (msg) => { if (status) status.textContent = msg || ''; };

  const cfg = window.SUPABASE_CONFIG || {};
  const ready =
    cfg.url && cfg.anonKey &&
    !cfg.url.includes('YOUR-PROJECT-REF') &&
    !cfg.anonKey.includes('YOUR-ANON');

  if (!ready) {
    // Distinguish the two failure modes: locally you forgot to generate the
    // config; on a host it means the build didn't run / env vars are missing.
    const local = ['localhost', '127.0.0.1', ''].includes(location.hostname);
    setStatus(
      local
        ? 'Supabase isn\'t configured — run `npm run config` after filling in .env.'
        : 'Supabase isn\'t configured on this deployment. Set SUPABASE_URL and ' +
          'SUPABASE_ANON_KEY in your host\'s environment variables and make sure ' +
          'the build command runs `npm run config`.'
    );
    return;
  }

  setStatus('Loading…');

  const db = window.supabase.createClient(cfg.url, cfg.anonKey);

  // Each property belongs to exactly one tab (migration 006). Ask for that
  // tab's properties only — the two galleries are independent lists.
  let query = db
    .from('properties')
    .select('slug, title, address, mode, property_videos(video_url, sort_order)')
    .eq('mode', currentMode())
    .order('created_at');

  let { data, error } = await query;

  // Before migration 006 there's no `mode` column; fall back to showing
  // everything rather than an empty gallery.
  if (error) {
    const all = await db
      .from('properties')
      .select('slug, title, address, property_videos(video_url, sort_order)')
      .order('created_at');
    if (all.error) {
      setStatus(`Couldn't load properties: ${all.error.message}`);
      return;
    }
    data = all.data;
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
    // Name the tab — an empty Video gallery next to a full Interactive one
    // otherwise looks like the properties vanished.
    const tab = currentMode() === 'video' ? 'Video Walkthrough' : 'Interactive Walkthrough';
    setStatus(`No ${tab} projects yet — use Upload/Edit to add one.`);
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
    card.href = walkthroughHref(property.slug);

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

    thumb.appendChild(buildShareButton(property, card.href));

    card.append(thumb, title, sub);
    return card;
  }

  /* Share lives inside the thumb, over the video. The card is an <a>, so the
     button has to stop the click from navigating into the walkthrough. */
  function buildShareButton(property, href) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'share-btn';
    btn.title = 'Share this walkthrough';
    btn.setAttribute('aria-label', `Share ${property.title}`);
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="18" cy="5" r="3"></circle>
        <circle cx="6" cy="12" r="3"></circle>
        <circle cx="18" cy="19" r="3"></circle>
        <line x1="8.6" y1="10.5" x2="15.4" y2="6.5"></line>
        <line x1="8.6" y1="13.5" x2="15.4" y2="17.5"></line>
      </svg>`;

    btn.addEventListener('click', async (e) => {
      e.preventDefault();   // don't open the walkthrough
      e.stopPropagation();

      const url = new URL(href, location.origin).href;
      const shareData = {
        title: `${property.title} — Lion Rock`,
        text: property.address ? `${property.title} · ${property.address}` : property.title,
        url,
      };

      // Native share sheet where it exists (phones); clipboard everywhere else.
      if (navigator.share) {
        try {
          await navigator.share(shareData);
          return;
        } catch (err) {
          // AbortError just means they dismissed the sheet — not a failure.
          if (err && err.name === 'AbortError') return;
        }
      }

      try {
        await navigator.clipboard.writeText(url);
        flash(btn, 'Copied');
      } catch {
        // Clipboard needs a secure context; fall back to a selectable prompt.
        window.prompt('Copy this link:', url);
      }
    });

    return btn;
  }

  /* Brief confirmation label next to the button. */
  function flash(btn, message) {
    const note = document.createElement('span');
    note.className = 'share-note';
    note.textContent = message;
    btn.insertAdjacentElement('afterend', note);
    setTimeout(() => note.remove(), 1600);
  }
}

// Render the active tab, and re-render whenever the tab changes.
wireModeTabs(renderGallery);
renderGallery();

/* The two tabs list different properties, so switching re-fetches rather than
   just re-pointing the existing cards. */
function wireModeTabs(onSwitch) {
  const tabs = [...document.querySelectorAll('.mode-tab')];
  if (!tabs.length) return;

  const paintActive = () => {
    const mode = currentMode();
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
  };

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      if (tab.dataset.mode === currentMode()) return;
      try { localStorage.setItem(MODE_KEY, tab.dataset.mode); } catch { /* ignore */ }
      paintActive();
      if (onSwitch) onSwitch();
    });
  });

  paintActive();
}

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
