/* The Videos tab — standalone videos, each with its own analytics.
 *
 * Unlike the other two tabs, these aren't properties with a room sequence:
 * one upload is one video, one card, one shareable link. That's why they live
 * in their own table (video_walkthroughs) rather than reusing `properties`.
 *
 * Every video carries a `token` — a short random id that appears in the share
 * link as /v/?v=<token>. Views are keyed by that token so a shared link can be
 * attributed without exposing the row id.
 *
 * Requires supabase/migrations/008-video-analytics.sql.
 */

(function () {
  const $ = (sel) => document.querySelector(sel);

  const cfg = window.SUPABASE_CONFIG || {};
  const configured =
    cfg.url && cfg.anonKey &&
    !cfg.url.includes('YOUR-PROJECT-REF') &&
    !cfg.anonKey.includes('YOUR-ANON');

  const db = configured ? window.supabase.createClient(cfg.url, cfg.anonKey) : null;
  const BUCKET = cfg.bucket || 'walkthrough-videos';

  let staged = null;        // the File waiting to be uploaded
  let rejectedSize = 0;     // size of the last file turned away for being too big
  let signedIn = false;

  /* Renders can overlap: gallery.js calls one on load, and the auth check calls
     another as soon as the session resolves. Both clear the grid and then wait
     on a query, so without this the two results would each append and every
     card would appear twice. Only the newest render may touch the grid. */
  let renderToken = 0;

  /* Largest file Storage will accept. Checked here as well as server-side so an
     oversized file is rejected instantly, rather than after uploading for a few
     minutes only to be turned away.

     This has to match the bucket's file_size_limit. Note that a Supabase
     project also has a global per-file cap that overrides the bucket setting
     (50MB on the free plan), so raising this alone isn't enough — raise the
     project limit under Settings → Storage first. */
  const MAX_UPLOAD_MB = Number(cfg.maxUploadMb) || 50;
  const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

  /* ---------- gallery ---------- */

  // gallery.js owns the grid for the other two tabs and re-renders on switch.
  // This exposes the Videos renderer so gallery.js can hand the grid over.
  window.VideoTab = { render: renderVideos, isActive: () => mode() === 'videos' };

  function mode() {
    try {
      return localStorage.getItem('lionrock-walkthrough-mode') || 'interactive';
    } catch {
      return 'interactive';
    }
  }

  async function renderVideos() {
    const grid = $('#grid');
    const status = $('#gallery-status');
    if (!grid) return;

    const mine = ++renderToken;
    // A newer render started while this one was waiting on the query — it owns
    // the grid now, so this one must not write anything.
    const superseded = () => mine !== renderToken;

    // The grid is cleared where it's replaced, not here: clearing up front
    // would let a second render wipe the cards the first one just placed.
    const setStatus = (m) => { if (status && !superseded()) status.textContent = m || ''; };

    if (!db) {
      grid.innerHTML = '';
      setStatus('Supabase isn\'t configured on this deployment.');
      return;
    }

    setStatus('Loading…');

    const { data, error } = await db
      .from('video_walkthroughs')
      .select('id, token, title, address, description, video_url, view_count, share_count')
      .order('created_at', { ascending: false });

    if (superseded()) return;

    if (error) {
      grid.innerHTML = '';
      setStatus(
        /video_walkthroughs/.test(error.message)
          ? 'Run supabase/migrations/008-video-analytics.sql in the Supabase SQL editor first.'
          : `Couldn't load videos: ${error.message}`
      );
      return;
    }

    if (!data || !data.length) {
      grid.innerHTML = '';
      setStatus('No videos yet — use Upload/Edit to add one.');
      return;
    }

    setStatus('');

    const frag = document.createDocumentFragment();
    data.forEach((v) => frag.appendChild(buildCard(v)));
    grid.replaceChildren(frag);   // replace, never append onto what's there

    lazyPreviews(grid);
  }

  function buildCard(video) {
    const card = document.createElement('a');
    card.className = 'card';
    card.href = shareHref(video.token);

    const thumb = document.createElement('div');
    thumb.className = 'thumb';

    const el = document.createElement('video');
    el.muted = true;
    el.loop = true;
    el.playsInline = true;
    el.preload = 'none';           // same lazy treatment as the other galleries
    el.dataset.src = video.video_url;
    thumb.appendChild(el);
    thumb.appendChild(shareButton(video, card.href));

    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = video.title;

    const sub = document.createElement('div');
    sub.className = 'card-sub';
    // Viewers see the address; admins also get the running counts at a glance.
    sub.textContent = signedIn
      ? `${video.address || '—'} · ${video.view_count} views · ${video.share_count} shares`
      : (video.address || '');

    card.append(thumb, title, sub);
    return card;
  }

  function shareHref(token) {
    return `/v/?v=${encodeURIComponent(token)}`;
  }

  /* Share also writes a row, so the share count means "someone took the link",
     not just "someone opened the menu". */
  function shareButton(video, href) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'share-btn';
    btn.title = 'Share this video';
    btn.setAttribute('aria-label', `Share ${video.title}`);
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
      e.preventDefault();
      e.stopPropagation();

      const url = new URL(href, location.origin).href;

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
        flash(btn, 'Copied');
        logShare(video, 'copy');
      } catch {
        window.prompt('Copy this link:', url);
        logShare(video, 'prompt');
      }
    });

    return btn;
  }

  async function logShare(video, channel) {
    if (!db) return;
    // Best-effort: a failed log must never break the share itself.
    try {
      await db.from('video_walkthrough_shares').insert({
        video_id: video.id,
        token: video.token,
        channel,
        shared_by: signedIn ? await currentEmail() : null,
      });
      await db.rpc('increment_video_share', { p_video_id: video.id });
    } catch { /* ignore */ }
  }

  async function currentEmail() {
    if (!window.AdminAuth) return null;
    const user = await window.AdminAuth.getUser();
    return user ? user.email : null;
  }

  function flash(btn, message) {
    const note = document.createElement('span');
    note.className = 'share-note';
    note.textContent = message;
    btn.insertAdjacentElement('afterend', note);
    setTimeout(() => note.remove(), 1600);
  }

  function lazyPreviews(grid) {
    const load = (v) => {
      if (v && !v.src && v.dataset.src) {
        v.src = v.dataset.src;
        v.preload = 'metadata';
      }
    };

    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver(
        (entries, obs) => entries.forEach((e) => {
          if (!e.isIntersecting) return;
          load(e.target.querySelector('video'));
          obs.unobserve(e.target);
        }),
        { rootMargin: '200px' }
      );
      grid.querySelectorAll('.card').forEach((c) => io.observe(c));
    } else {
      grid.querySelectorAll('.card video').forEach(load);
    }

    grid.querySelectorAll('.card').forEach((card) => {
      const v = card.querySelector('video');
      card.addEventListener('mouseenter', () => { load(v); v.play().catch(() => {}); });
      card.addEventListener('mouseleave', () => { v.pause(); v.currentTime = 0; });
    });
  }

  /* ---------- upload ---------- */

  const modal = $('#video-modal');
  const drop = $('#video-drop');
  const fileInput = drop && drop.querySelector('input[type=file]');

  function openModal() {
    if (!modal) return;
    modal.classList.add('open');
    resetForm();
    listVideos();
  }

  function closeModal() {
    if (modal) modal.classList.remove('open');
  }

  function resetForm() {
    staged = null;
    rejectedSize = 0;
    ['#video-title', '#video-address', '#video-description'].forEach((s) => {
      const el = $(s);
      if (el) el.value = '';
    });
    if (drop) {
      drop.classList.remove('staged', 'done', 'error', 'dragging');
      drop.querySelector('.area-hint').textContent = 'Drop a video here, or click to choose';
      const limit = drop.querySelector('.drop-limit');
      if (limit) limit.textContent = `MP4, MOV or WebM · up to ${MAX_UPLOAD_MB} MB`;
    }
    setStatus('');
  }

  function setStatus(msg, isError) {
    const el = $('#video-status');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('error', !!isError);
  }

  if (drop) {
    // Paint the limit immediately, not just when the modal is next reset.
    const limitEl = drop.querySelector('.drop-limit');
    if (limitEl) limitEl.textContent = `MP4, MOV or WebM · up to ${MAX_UPLOAD_MB} MB`;

    drop.addEventListener('click', () => fileInput && fileInput.click());
    if (fileInput) {
      fileInput.addEventListener('change', () => {
        if (fileInput.files && fileInput.files[0]) stageFile(fileInput.files[0]);
      });
    }
    ['dragenter', 'dragover'].forEach((ev) =>
      drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('dragging'); })
    );
    ['dragleave', 'drop'].forEach((ev) =>
      drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('dragging'); })
    );
    drop.addEventListener('drop', (e) => {
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) stageFile(file);
    });
  }

  function stageFile(file) {
    if (!file.type.startsWith('video/')) {
      rejectedSize = 0;   // this one was refused for its type, not its size
      setStatus('That file isn\'t a video.', true);
      return;
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      staged = null;
      rejectedSize = file.size;
      drop.classList.remove('staged', 'done');
      drop.classList.add('error');
      drop.querySelector('.area-hint').textContent =
        `${file.name} · ${mb(file.size)} MB — too large`;
      setStatus(
        `That video is ${mb(file.size)} MB. The limit is ${MAX_UPLOAD_MB} MB — ` +
        'compress it or trim it down, then try again.',
        true
      );
      return;
    }

    staged = file;
    rejectedSize = 0;
    drop.classList.remove('error', 'done');
    drop.classList.add('staged');
    drop.querySelector('.area-hint').textContent = `${file.name} · ${mb(file.size)} MB`;
    setStatus('');
  }

  function mb(bytes) {
    return (bytes / 1048576).toFixed(1);
  }

  const saveBtn = $('#video-save');
  if (saveBtn) saveBtn.addEventListener('click', upload);

  async function upload() {
    if (!db) return setStatus('Supabase isn\'t configured.', true);

    const title = ($('#video-title').value || '').trim();
    if (!title) return setStatus('Give the video a title.', true);
    if (!staged) {
      // Don't replace the size explanation with a vaguer message — the file was
      // chosen, it was just too big.
      return setStatus(
        rejectedSize
          ? `That video is ${mb(rejectedSize)} MB, over the ${MAX_UPLOAD_MB} MB limit. ` +
            'Choose a smaller file.'
          : 'Choose a video file first.',
        true
      );
    }

    saveBtn.disabled = true;
    setStatus('Uploading…');

    const token = makeToken();
    const ext = (staged.name.split('.').pop() || 'mp4').toLowerCase();
    const path = `videos/${token}.${ext}`;

    const { error: upErr } = await db.storage
      .from(BUCKET)
      .upload(path, staged, { upsert: true, contentType: staged.type });

    if (upErr) {
      saveBtn.disabled = false;
      // Storage's own wording for an oversized file doesn't say what the limit
      // is or what to do about it, so say both.
      const tooBig = /exceeded the maximum allowed size|payload too large/i
        .test(upErr.message || '');
      return setStatus(
        tooBig
          ? `That video is ${mb(staged.size)} MB, over the ${MAX_UPLOAD_MB} MB limit. ` +
            'Compress it or trim it down, then try again.'
          : `Upload failed: ${upErr.message}`,
        true
      );
    }

    const { data: pub } = db.storage.from(BUCKET).getPublicUrl(path);

    const { error: rowErr } = await db.from('video_walkthroughs').insert({
      token,
      title,
      address: ($('#video-address').value || '').trim() || null,
      description: ($('#video-description').value || '').trim() || null,
      video_url: pub.publicUrl,
      storage_path: path,
      creator: await currentEmail(),
    });

    saveBtn.disabled = false;

    if (rowErr) {
      return setStatus(
        /video_walkthroughs/.test(rowErr.message)
          ? 'Run supabase/migrations/008-video-analytics.sql first.'
          : `Couldn't save: ${rowErr.message}`,
        true
      );
    }

    setStatus('Uploaded.');
    resetForm();
    listVideos();
    if (mode() === 'videos') renderVideos();
  }

  /* Short, URL-safe, and random enough that share links can't be guessed by
     walking a sequence. */
  function makeToken() {
    const bytes = new Uint8Array(9);
    crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /* ---------- manage list ---------- */

  async function listVideos() {
    const list = $('#video-list');
    if (!list || !db) return;

    const { data, error } = await db
      .from('video_walkthroughs')
      .select('id, token, title, address, storage_path, view_count, share_count')
      .order('created_at', { ascending: false });

    if (error || !data || !data.length) {
      list.innerHTML = '';
      return;
    }

    list.innerHTML = '<h3>Uploaded videos</h3>';

    data.forEach((v) => {
      const row = document.createElement('div');
      row.className = 'video-row';

      const main = document.createElement('div');
      main.className = 'video-row-main';
      main.innerHTML = '<div class="video-row-title"></div><div class="video-row-sub"></div>';
      main.querySelector('.video-row-title').textContent = v.title;
      main.querySelector('.video-row-sub').textContent =
        `${v.view_count} views · ${v.share_count} shares`;

      const actions = document.createElement('div');
      actions.className = 'video-row-actions';

      const stats = document.createElement('button');
      stats.type = 'button';
      stats.className = 'mini-btn';
      stats.textContent = 'Analytics';
      stats.addEventListener('click', () => openStats(v));

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'mini-btn danger';
      del.textContent = 'Delete';
      del.addEventListener('click', () => removeVideo(v, row));

      actions.append(stats, del);
      row.append(main, actions);
      list.appendChild(row);
    });
  }

  async function removeVideo(video, row) {
    if (!window.confirm(`Delete "${video.title}"? This also removes its analytics.`)) return;

    // The file first: if the row went first and this failed, the object would
    // be orphaned in storage with nothing left pointing at it.
    if (video.storage_path) {
      await db.storage.from(BUCKET).remove([video.storage_path]).catch(() => {});
    }

    const { error } = await db.from('video_walkthroughs').delete().eq('id', video.id);
    if (error) {
      setStatus(`Couldn't delete: ${error.message}`, true);
      return;
    }

    row.remove();
    if (mode() === 'videos') renderVideos();
  }

  /* ---------- analytics ---------- */

  async function openStats(video) {
    const panel = $('#stats-modal');
    const body = $('#stats-body');
    if (!panel || !body) return;

    $('#stats-title').textContent = video.title;
    $('#stats-sub').textContent = video.address || '';
    body.innerHTML = '<p class="stat-empty">Loading…</p>';
    panel.classList.add('open');

    const [views, shares] = await Promise.all([
      db.from('video_walkthrough_views')
        .select('ip_address, user_agent, referrer, city, region, country, viewed_at')
        .eq('video_id', video.id)
        .order('viewed_at', { ascending: false })
        .limit(500),
      db.from('video_walkthrough_shares')
        .select('channel, shared_by, shared_at')
        .eq('video_id', video.id)
        .order('shared_at', { ascending: false })
        .limit(200),
    ]);

    if (views.error) {
      body.innerHTML = '';
      body.appendChild(note(`Couldn't load analytics: ${views.error.message}`));
      return;
    }

    const rows = views.data || [];
    const shareRows = shares.data || [];
    // Distinct IPs is the closer stand-in for "people"; total views counts
    // repeat visits from the same viewer.
    const unique = new Set(rows.map((r) => r.ip_address).filter(Boolean)).size;

    body.innerHTML = '';
    body.appendChild(statCards([
      ['Total views', video.view_count],
      ['Unique IPs', unique],
      ['Shares', video.share_count],
    ]));

    body.appendChild(shareLink(video));
    body.appendChild(viewerTable(rows));
    body.appendChild(shareTable(shareRows));
  }

  function statCards(pairs) {
    const wrap = document.createElement('div');
    wrap.className = 'stat-cards';
    pairs.forEach(([label, value]) => {
      const card = document.createElement('div');
      card.className = 'stat-card';
      card.innerHTML = '<div class="stat-value"></div><div class="stat-label"></div>';
      card.querySelector('.stat-value').textContent = value == null ? 0 : value;
      card.querySelector('.stat-label').textContent = label;
      wrap.appendChild(card);
    });
    return wrap;
  }

  function shareLink(video) {
    const section = document.createElement('div');
    section.className = 'stat-section';
    section.style.marginBottom = '26px';
    section.innerHTML = '<h3>Share link</h3>';

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;align-items:center;flex-wrap:wrap';

    const url = new URL(shareHref(video.token), location.origin).href;

    const input = document.createElement('input');
    input.readOnly = true;
    input.value = url;
    input.style.cssText =
      'flex:1 1 260px;padding:10px 12px;background:#000;color:#f5f3ee;' +
      'border:1px solid rgba(245,243,238,.2);font-size:.78rem;' +
      'font-family:ui-monospace,Menlo,monospace';
    input.addEventListener('focus', () => input.select());

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'mini-btn';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(url);
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
        logShare(video, 'copy');
      } catch {
        input.select();
      }
    });

    row.append(input, copy);
    section.appendChild(row);
    return section;
  }

  function viewerTable(rows) {
    const section = document.createElement('div');
    section.className = 'stat-section';
    section.style.marginBottom = '26px';
    section.innerHTML = '<h3>Viewers</h3>';

    if (!rows.length) {
      section.appendChild(note('No views logged yet.'));
      return section;
    }

    const scroll = document.createElement('div');
    scroll.className = 'stat-scroll';

    const table = document.createElement('table');
    table.className = 'ip-table';
    table.innerHTML =
      '<thead><tr><th>IP address</th><th>Location</th><th>When</th><th>Browser</th></tr></thead>';

    const tbody = document.createElement('tbody');
    rows.forEach((r) => {
      const tr = document.createElement('tr');

      const ip = document.createElement('td');
      ip.className = 'ip';
      ip.textContent = r.ip_address || '—';

      const loc = document.createElement('td');
      loc.textContent = [r.city, r.region, r.country].filter(Boolean).join(', ') || '—';

      const when = document.createElement('td');
      when.textContent = formatDate(r.viewed_at);

      const agent = document.createElement('td');
      agent.className = 'agent';
      agent.title = r.user_agent || '';
      agent.textContent = shortAgent(r.user_agent);

      tr.append(ip, loc, when, agent);
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    scroll.appendChild(table);
    section.appendChild(scroll);
    return section;
  }

  function shareTable(rows) {
    const section = document.createElement('div');
    section.className = 'stat-section';
    section.innerHTML = '<h3>Shares</h3>';

    if (!rows.length) {
      section.appendChild(note('No shares logged yet.'));
      return section;
    }

    const table = document.createElement('table');
    table.className = 'ip-table';
    table.innerHTML = '<thead><tr><th>Channel</th><th>By</th><th>When</th></tr></thead>';

    const tbody = document.createElement('tbody');
    rows.forEach((r) => {
      const tr = document.createElement('tr');
      [r.channel || '—', r.shared_by || 'anonymous', formatDate(r.shared_at)].forEach((text) => {
        const td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    section.appendChild(table);
    return section;
  }

  function note(text) {
    const p = document.createElement('p');
    p.className = 'stat-empty';
    p.textContent = text;
    return p;
  }

  function formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? '—'
      : d.toLocaleString(undefined, {
          month: 'short', day: 'numeric',
          hour: 'numeric', minute: '2-digit',
        });
  }

  /* Full user-agent strings are unreadable in a table; the browser name is the
     part anyone actually looks at. The full string stays in the title. */
  function shortAgent(ua) {
    if (!ua) return '—';
    const browser =
      /Edg\//.test(ua) ? 'Edge'
      : /OPR\//.test(ua) ? 'Opera'
      : /Chrome\//.test(ua) ? 'Chrome'
      : /Safari\//.test(ua) ? 'Safari'
      : /Firefox\//.test(ua) ? 'Firefox'
      : 'Other';
    const os =
      /iPhone|iPad/.test(ua) ? 'iOS'
      : /Android/.test(ua) ? 'Android'
      : /Mac OS X/.test(ua) ? 'macOS'
      : /Windows/.test(ua) ? 'Windows'
      : '';
    return os ? `${browser} · ${os}` : browser;
  }

  /* ---------- wiring ---------- */

  ['#video-close', '#stats-close'].forEach((sel) => {
    const btn = $(sel);
    if (btn) {
      btn.addEventListener('click', () => {
        btn.closest('#video-modal, #stats-modal').classList.remove('open');
      });
    }
  });

  [modal, $('#stats-modal')].forEach((panel) => {
    if (!panel) return;
    panel.addEventListener('click', (e) => {
      if (e.target === panel) panel.classList.remove('open');
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Only the topmost one, so Escape in Analytics doesn't also close Upload.
    const stats = $('#stats-modal');
    if (stats && stats.classList.contains('open')) stats.classList.remove('open');
    else closeModal();
  });

  /* The Upload/Edit button is shared with the other two tabs, so which modal it
     opens depends on which tab is showing. Capture phase, because upload.js has
     its own click listener on the same button — stopping propagation here keeps
     the property modal from opening on top of this one. */
  const uploadBtn = $('#upload-btn');
  if (uploadBtn) {
    uploadBtn.addEventListener('click', (e) => {
      if (mode() !== 'videos') return;
      e.stopImmediatePropagation();
      e.preventDefault();
      openModal();
    }, true);
  }

  if (window.AdminAuth) {
    const apply = (user) => {
      const was = signedIn;
      signedIn = !!user;

      if (!user) {
        closeModal();
        const stats = $('#stats-modal');
        if (stats) stats.classList.remove('open');
      }

      // Card subtitles differ for admins, so a session change needs a re-render
      // — but only when it actually changed. Re-rendering on every auth event
      // races the render gallery.js already started on load.
      if (was !== signedIn && mode() === 'videos') renderVideos();
    };
    window.AdminAuth.getUser().then(apply);
    window.AdminAuth.onChange(apply);
  }
})();
