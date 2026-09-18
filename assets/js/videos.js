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
  let editing = null;       // the video being edited, or null when adding a new one
  let signedIn = false;

  /* Renders can overlap: gallery.js calls one on load, and the auth check calls
     another as soon as the session resolves. Both clear the grid and then wait
     on a query, so without this the two results would each append and every
     card would appear twice. Only the newest render may touch the grid. */
  let renderToken = 0;

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
  const saveBtn = $('#video-save');
  const fileInput = drop && drop.querySelector('input[type=file]');

  function openModal() {
    if (!modal) return;
    modal.classList.add('open');
    editing = null;          // always opens on the "add new" form
    resetForm();
    paintMode();
    listVideos();
  }

  function closeModal() {
    if (modal) modal.classList.remove('open');
  }

  /* Loads an existing video into the form. The file becomes optional here —
     leaving it empty keeps the current video and saves only the details. */
  function startEdit(video) {
    editing = video;
    staged = null;

    $('#video-title').value = video.title || '';
    $('#video-address').value = video.address || '';
    $('#video-description').value = video.description || '';

    if (drop) {
      drop.classList.remove('staged', 'done', 'error', 'dragging');
      drop.querySelector('.area-hint').textContent = 'Drop a new video to replace it';
      const limit = drop.querySelector('.drop-limit');
      if (limit) limit.textContent = 'Optional — leave empty to keep the current video';
    }

    paintMode();
    listVideos();          // repaint so the edited row is highlighted
    setStatus('');
    if (modal) modal.scrollTop = 0;
  }

  function cancelEdit() {
    editing = null;
    resetForm();
    paintMode();
    listVideos();
  }

  /* The modal does double duty, so its wording has to say which it is. */
  function paintMode() {
    const heading = $('#video-modal h2');
    const sub = $('#video-modal .upload-sub');
    const cancel = $('#video-cancel');

    if (editing) {
      if (heading) heading.textContent = 'Edit video';
      if (sub) sub.textContent = 'Change the details, or drop a new file to replace the video.';
      if (saveBtn) saveBtn.textContent = 'Save changes';
      if (cancel) cancel.hidden = false;
    } else {
      if (heading) heading.textContent = 'Videos';
      if (sub) {
        sub.textContent =
          'Upload a single video. Each one gets its own shareable link and tracks ' +
          'views, shares, and viewer IPs.';
      }
      if (saveBtn) saveBtn.textContent = 'Upload';
      if (cancel) cancel.hidden = true;
    }
  }

  function resetForm() {
    staged = null;
    ['#video-title', '#video-address', '#video-description'].forEach((s) => {
      const el = $(s);
      if (el) el.value = '';
    });
    if (drop) {
      drop.classList.remove('staged', 'done', 'error', 'dragging');
      drop.querySelector('.area-hint').textContent = 'Drop a video here, or click to choose';
      const limit = drop.querySelector('.drop-limit');
      if (limit) limit.textContent = 'MP4, MOV or WebM';
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
    if (limitEl) limitEl.textContent = 'MP4, MOV or WebM';

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
      setStatus('That file isn\'t a video.', true);
      return;
    }

    staged = file;
    drop.classList.remove('error', 'done');
    drop.classList.add('staged');
    drop.querySelector('.area-hint').textContent = `${file.name} · ${mb(file.size)} MB`;
    setStatus('');
  }

  function mb(bytes) {
    return (bytes / 1048576).toFixed(1);
  }

  if (saveBtn) saveBtn.addEventListener('click', upload);

  const cancelBtn = $('#video-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', cancelEdit);

  async function upload() {
    if (!db) return setStatus('Supabase isn\'t configured.', true);

    const title = ($('#video-title').value || '').trim();
    if (!title) return setStatus('Give the video a title.', true);

    // A new video needs a file; an edit doesn't — no file just means "keep the
    // one that's already there".
    if (!staged && !editing) {
      return setStatus('Choose a video file first.', true);
    }

    saveBtn.disabled = true;

    const fields = {
      title,
      address: ($('#video-address').value || '').trim() || null,
      description: ($('#video-description').value || '').trim() || null,
    };

    let uploaded = null;   // { path, url } when a file was sent this time
    let newToken = null;   // the share token, for a newly created row

    if (staged) {
      setStatus('Uploading…');

      // An edit reuses the existing token so the share link a viewer already
      // has keeps working. Only the extension can change.
      newToken = editing ? editing.token : makeToken();
      const ext = (staged.name.split('.').pop() || 'mp4').toLowerCase();
      const path = `videos/${newToken}.${ext}`;

      const { error: upErr } = await db.storage
        .from(BUCKET)
        .upload(path, staged, { upsert: true, contentType: staged.type });

      if (upErr) {
        saveBtn.disabled = false;
        // There's no size check here any more, so Storage is the one that says
        // no. Its wording doesn't mention the file or what to do, so say both —
        // the limit itself comes from the Supabase project, not from this code.
        const tooBig = /exceeded the maximum allowed size|payload too large/i
          .test(upErr.message || '');
        return setStatus(
          tooBig
            ? `Storage rejected this ${mb(staged.size)} MB video — the limit is ` +
              '50 MB. Compress it or trim it down. (Raising the limit needs a ' +
              'paid Supabase plan; it is a project-wide cap, not a setting here.)'
            : `Upload failed: ${upErr.message}`,
          true
        );
      }

      const { data: pub } = db.storage.from(BUCKET).getPublicUrl(path);

      // Replacing a clip reuses the storage path, so the public URL wouldn't
      // change and caches would keep serving the OLD video. A version stamp
      // makes each replacement a distinct URL.
      uploaded = { path, url: `${pub.publicUrl}?v=${Date.now()}` };
      fields.video_url = uploaded.url;
      fields.storage_path = path;
    } else {
      setStatus('Saving…');
    }

    const { error: rowErr } = editing
      ? await db.from('video_walkthroughs').update(fields).eq('id', editing.id)
      : await db.from('video_walkthroughs').insert({
          ...fields,
          token: newToken,
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

    // A replacement with a different extension writes a different object,
    // leaving the old file behind — still stored, still billed. Remove it, but
    // only once the row no longer points at it.
    if (uploaded && editing && editing.storage_path &&
        editing.storage_path !== uploaded.path) {
      await db.storage.from(BUCKET).remove([editing.storage_path]).catch(() => {});
    }

    setStatus(editing ? 'Saved.' : 'Uploaded.');
    editing = null;
    resetForm();
    paintMode();
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
      .select('id, token, title, address, description, storage_path, view_count, share_count')
      .order('created_at', { ascending: false });

    if (error || !data || !data.length) {
      list.innerHTML = '';
      return;
    }

    list.innerHTML = '<h3>Uploaded videos</h3>';

    data.forEach((v) => {
      const row = document.createElement('div');
      row.className = 'video-row';
      // Mark the one the form is currently editing, so the two are connected.
      if (editing && editing.id === v.id) row.classList.add('editing');

      const main = document.createElement('div');
      main.className = 'video-row-main';
      main.innerHTML = '<div class="video-row-title"></div><div class="video-row-sub"></div>';
      main.querySelector('.video-row-title').textContent = v.title;
      main.querySelector('.video-row-sub').textContent =
        `${v.view_count} views · ${v.share_count} shares`;

      const actions = document.createElement('div');
      actions.className = 'video-row-actions';

      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'mini-btn';
      edit.textContent = 'Edit';
      edit.addEventListener('click', () => startEdit(v));

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

      actions.append(edit, stats, del);
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

  /* A busy video can log hundreds of views, which would run off the bottom of
     the panel. Show a page at a time instead. */
  const ROWS_PER_PAGE = 7;

  function viewerTable(rows) {
    return pagedTable({
      heading: 'Viewers',
      empty: 'No views logged yet.',
      columns: ['IP address', 'Location', 'When', 'Browser'],
      rows,
      buildRow(r) {
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
        return tr;
      },
    });
  }

  /* One table, ROWS_PER_PAGE at a time, with Prev/Next below it. The controls
     are left out entirely when everything fits on one page. */
  function pagedTable({ heading, empty, columns, rows, buildRow }) {
    const section = document.createElement('div');
    section.className = 'stat-section';
    section.style.marginBottom = '26px';

    const h = document.createElement('h3');
    h.textContent = heading;
    section.appendChild(h);

    if (!rows.length) {
      section.appendChild(note(empty));
      return section;
    }

    const table = document.createElement('table');
    table.className = 'ip-table';

    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    columns.forEach((label) => {
      const th = document.createElement('th');
      th.textContent = label;
      headRow.appendChild(th);
    });
    head.appendChild(headRow);
    table.appendChild(head);

    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    section.appendChild(table);

    const pages = Math.ceil(rows.length / ROWS_PER_PAGE);
    let page = 0;

    if (pages === 1) {
      rows.forEach((r) => tbody.appendChild(buildRow(r)));
      return section;
    }

    const nav = document.createElement('div');
    nav.className = 'page-nav';

    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'mini-btn';
    prev.textContent = 'Prev';

    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'mini-btn';
    next.textContent = 'Next';

    const label = document.createElement('span');
    label.className = 'page-label';

    nav.append(prev, label, next);
    section.appendChild(nav);

    const draw = () => {
      const start = page * ROWS_PER_PAGE;
      const slice = rows.slice(start, start + ROWS_PER_PAGE);

      tbody.replaceChildren(...slice.map(buildRow));

      // Say which records these are, not just which page — "8–14 of 31" tells
      // you more than "Page 2 of 5".
      label.textContent =
        `${start + 1}–${start + slice.length} of ${rows.length}`;

      prev.disabled = page === 0;
      next.disabled = page >= pages - 1;
    };

    prev.addEventListener('click', () => { if (page > 0) { page--; draw(); } });
    next.addEventListener('click', () => { if (page < pages - 1) { page++; draw(); } });

    draw();
    return section;
  }

  function shareTable(rows) {
    const section = pagedTable({
      heading: 'Shares',
      empty: 'No shares logged yet.',
      columns: ['Channel', 'By', 'When'],
      rows,
      buildRow(r) {
        const tr = document.createElement('tr');
        [r.channel || '—', r.shared_by || 'anonymous', formatDate(r.shared_at)]
          .forEach((text) => {
            const td = document.createElement('td');
            td.textContent = text;
            tr.appendChild(td);
          });
        return tr;
      },
    });
    section.style.marginBottom = '0';   // last section in the panel
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
