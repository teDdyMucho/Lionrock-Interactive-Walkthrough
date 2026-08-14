/* Lion Rock — Video Walkthrough
 *
 * Click-driven. One rule: click a room, that room's clip plays, start to finish,
 * then holds on its last frame. Same in both directions, however far you jump.
 *
 * Scroll/swipe/arrow keys step one room at a time through the same path.
 */

(() => {
  'use strict';

  const els = {
    loader: document.getElementById('loader'),
    loaderFill: document.getElementById('loader-bar-fill'),
    loaderLabel: document.getElementById('loader-label'),
    nav: document.getElementById('room-nav'),
    dotNav: document.getElementById('dot-nav'),
    stage: document.getElementById('stage'),
    videoA: document.getElementById('video-a'),
    videoB: document.getElementById('video-b'),
    footerNote: document.getElementById('footer-note'),
  };

  let rooms = [];
  let activeIndex = 0;
  let walkToken = 0;         // bumped per click; an older clip sees it and stops

  // Remote URL -> local blob: URL, filled by preload(). Playback reads from
  // here so a clip never has to be fetched mid-walk.
  const blobUrls = new Map();
  const localSrc = (url) => blobUrls.get(url) || url;

  // Two <video> elements ping-pong so the next clip can buffer while the
  // current one is on screen.
  const slots = [
    { el: els.videoA, src: null },
    { el: els.videoB, src: null },
  ];
  let activeSlot = 0;

  init();

  async function init() {
    let data;
    try {
      data = await loadVideoRooms();
    } catch (err) {
      showError(err);
      return;
    }

    applyChrome(data.property);
    rooms = data.rooms;
    buildNav();

    await preload();
    revealSite();
    wireScrubInput();   // scroll/swipe/arrow keys move between rooms

    // Opening a property plays the tour on its own, room after room, looping
    // back to the first. Deliberately not awaited - it never resolves.
    autoRun(0);

    maybeShowGuide();
  }

  /* Plays every room back-to-back, wrapping past the last one to the first, for
     as long as nobody interacts. Shares walkToken with goToRoom, so the first
     click/scroll/swipe cancels it mid-clip and hands pacing to the viewer -
     from then on they drive, and the player holds wherever they put it. */
  async function autoRun(startIndex) {
    // playClip resolves instantly for a room with no clip, so with nothing
    // playable this would spin forever.
    if (!rooms.some((room) => room.video)) return;

    const myRun = walkToken += 1;
    let index = startIndex;

    while (myRun === walkToken) {
      activeIndex = index;
      highlight(index);

      // Hand the next clip over so it buffers on the free slot while this one
      // is on screen - otherwise every room boundary waits on a `canplay`.
      const next = (index + 1) % rooms.length;
      await playClip(rooms[index].video, rooms[next].video);
      if (myRun !== walkToken) return;   // superseded by a click or gesture

      index = next;
    }
  }

  function applyChrome(property) {
    els.footerNote.textContent = property.footerNote || '';
    // No loader backdrop — the download screen stays black on purpose.
    document.title = `${property.title} — Lion Rock`;
  }

  function buildNav() {
    rooms.forEach((room, i) => {
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = room.label;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        goToRoom(i);
      });
      els.nav.appendChild(a);
      room.navLink = a;
    });
    buildDotNav();
    highlight(0);
  }

  /* Same room list as the header, down the right edge. Reuses the Interactive
     player's markup and styles so the two tabs feel identical. */
  function buildDotNav() {
    if (!els.dotNav) return;

    rooms.forEach((room, i) => {
      const row = document.createElement('div');
      row.className = 'dot-row';

      const label = document.createElement('span');
      label.className = 'dot-label';
      label.textContent = room.label;

      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'dot';
      dot.setAttribute('aria-label', room.label);
      dot.addEventListener('click', () => goToRoom(i));

      row.appendChild(label);
      row.appendChild(dot);
      els.dotNav.appendChild(row);
      room.dotRow = row;
    });
  }

  function highlight(index) {
    rooms.forEach((room, i) => {
      if (room.navLink) room.navLink.classList.toggle('active', i === index);

      if (!room.dotRow) return;
      // active / label-above / label-below drive the label's slide-in, matching
      // the Interactive player's behaviour.
      room.dotRow.classList.remove('active', 'label-above', 'label-below');
      room.dotRow.classList.add(
        i === index ? 'active' : i < index ? 'label-above' : 'label-below'
      );
    });
  }

  /* ---------- first-visit guide ---------- */

  const GUIDE_SEEN_KEY = 'lionrock-video-guide-seen';
  const IS_TOUCH = window.matchMedia('(hover: none) and (pointer: coarse)').matches;

  /* Four steps explaining the controls, shown once per browser. Its own key,
     separate from the Interactive tab's — the two players work differently
     enough that seeing one doesn't teach you the other. */
  function maybeShowGuide() {
    const guide = document.getElementById('guide');
    if (!guide) return;

    try {
      if (localStorage.getItem(GUIDE_SEEN_KEY)) return;
    } catch { /* storage blocked — still worth showing once */ }

    document.getElementById('guide-text-0').textContent =
      IS_TOUCH ? 'Swipe Up for the Next Room' : 'Scroll Down for the Next Room';
    document.getElementById('guide-text-1').textContent =
      IS_TOUCH ? 'Swipe Down to Go Back' : 'Scroll Up to Go Back';
    document.getElementById('guide-hint').textContent =
      IS_TOUCH ? 'Tap anywhere to continue' : 'Click anywhere to continue';

    const steps = [...guide.querySelectorAll('.guide-step')];
    let index = 0;

    const show = (i) => {
      steps.forEach((s, n) => s.classList.toggle('active', n === i));
      // Anchor the pointer steps to the real controls they describe.
      if (i === 2) anchorTo(steps[2], els.nav.querySelector('a:nth-child(2)'));
      if (i === 3) anchorTo(steps[3], document.getElementById('back-to-gallery'));
    };

    const advance = () => {
      index += 1;
      if (index >= steps.length) {
        guide.classList.remove('show');
        document.body.classList.remove('guide-open');
        try { localStorage.setItem(GUIDE_SEEN_KEY, '1'); } catch { /* ignore */ }
        return;
      }
      show(index);
    };

    guide.addEventListener('click', advance);
    guide.addEventListener('touchend', (e) => { e.preventDefault(); advance(); });

    // Scrolling while the guide is up would move rooms behind it. Swallow the
    // gesture and advance instead, throttled so one flick doesn't skip steps.
    let locked = false;
    const onGesture = (e) => {
      e.preventDefault();
      if (locked) return;
      locked = true;
      setTimeout(() => { locked = false; }, 700);
      advance();
    };
    guide.addEventListener('wheel', onGesture, { passive: false });
    guide.addEventListener('touchmove', onGesture, { passive: false });

    show(0);
    guide.classList.add('show');
    document.body.classList.add('guide-open');
  }

  /* Draws the ring around a control and centres the label under it. Sized from
     the target so it hugs a short label and a long one equally well. */
  function anchorTo(step, target) {
    if (!target) return;

    const r = target.getBoundingClientRect();
    const ring = step.querySelector('.guide-ring');

    const ringW = r.width + 26;
    const ringH = r.height + 14;
    if (ring) {
      ring.style.width = `${ringW}px`;
      ring.style.height = `${ringH}px`;
    }

    step.style.width = `${ringW}px`;
    step.style.left = `${r.left + r.width / 2 - ringW / 2}px`;
    step.style.top = `${r.top + r.height / 2 - ringH / 2}px`;
    step.style.transform = 'none';
  }

  /* ---------- scroll / swipe navigation ---------- */

  /* One gesture = one room, matching the Interactive tab's direction:
     scroll/swipe DOWN moves forward, UP goes back.

     A single wheel flick fires dozens of events and a swipe fires continuously,
     so both are throttled — otherwise one scroll would race through every room.
     The lock clears when the transition finishes rather than on a fixed timer,
     so it can't queue moves faster than the clips can play. */
  let gestureLocked = false;
  const TOUCH_THRESHOLD = 40;   // px of swipe before it counts as a move

  function step(delta) {
    if (gestureLocked) return;
    const target = activeIndex + delta;
    if (target < 0 || target >= rooms.length) return;   // at either end

    gestureLocked = true;
    goToRoom(target).finally(() => { gestureLocked = false; });
  }

  function wireScrubInput() {
    window.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (Math.abs(e.deltaY) < 4) return;   // ignore trackpad jitter
      step(e.deltaY > 0 ? 1 : -1);          // down = next
    }, { passive: false });

    let touchStartY = null;
    window.addEventListener('touchstart', (e) => {
      touchStartY = e.touches[0].clientY;
    }, { passive: true });

    window.addEventListener('touchmove', (e) => {
      e.preventDefault();                   // don't let the page rubber-band
      if (touchStartY === null) return;
      const dy = touchStartY - e.touches[0].clientY;
      if (Math.abs(dy) < TOUCH_THRESHOLD) return;
      touchStartY = null;                   // one move per swipe
      step(dy > 0 ? 1 : -1);                // swipe up (content moves up) = next
    }, { passive: false });

    window.addEventListener('touchend', () => { touchStartY = null; }, { passive: true });

    // Keyboard, for free: arrows and page keys follow the same rule.
    window.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); step(1); }
      if (e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); step(-1); }
    });
  }

  /* ---------- navigation ---------- */

  /* Click a room, play that room. Nothing else.

     This used to chain: clicking a room three away played every clip in between,
     and going backward played a pre-rendered reversed clip out of the current
     room first. That's why clicking Kitchen from Living showed Dining - Dining
     was an intermediate leg, not a bug in the mapping. The nav means "show me
     this room", so it now plays exactly the clip the label points at. */
  async function goToRoom(target) {
    if (!rooms[target]) return;

    // A newer click supersedes the clip in flight. It can't be aborted
    // mid-await, so playClip watches this token and resolves if it's replaced.
    walkToken += 1;

    // Stop whatever is mid-play, so the interrupted clip doesn't keep running
    // (and firing 'ended') underneath the new one.
    slots.forEach((s) => { if (!s.el.paused) s.el.pause(); });

    // The nav answers the click straight away - before the clip loads - so it
    // always shows what you actually clicked.
    activeIndex = target;
    highlight(target);

    // Buffer the following room so a forward gesture from here starts instantly.
    const after = rooms[target + 1];
    await playClip(rooms[target].video, after && after.video);
  }

  /* Plays one clip start to finish on the standby slot, swaps it in, and
     resolves when it ends (holding on the last frame).

     `nextUrl`, when given, is buffered on the freed-up slot as soon as this clip
     is on screen, so the following playClip finds it already decodable and
     starts instantly instead of waiting on `canplay`. */
  function playClip(remoteUrl, nextUrl) {
    const startedAt = walkToken;   // so an interrupted clip can stop waiting

    return new Promise((resolve) => {
      if (!remoteUrl) { resolve(); return; }

      const src = localSrc(remoteUrl);   // preloaded blob, never the network
      const standbyIdx = 1 - activeSlot;
      const standby = slots[standbyIdx];

      const start = () => {
        standby.el.currentTime = 0;
        standby.el.playbackRate = 1;   // every clip plays at the same speed

        // Swap only once the new clip has actually painted its first frame.
        // Swapping on play() alone can show a blank element for a frame or two.
        const reveal = () => {
          slots[activeSlot].el.classList.remove('active');
          standby.el.classList.add('active');
          activeSlot = standbyIdx;
          prewarm(nextUrl);   // the slot just vacated buffers what comes next
        };

        if (typeof standby.el.requestVideoFrameCallback === 'function') {
          standby.el.requestVideoFrameCallback(reveal);
        } else {
          standby.el.addEventListener('timeupdate', reveal, { once: true });
        }

        standby.el.play().catch(() => { reveal(); });
      };

      const done = () => {
        standby.el.removeEventListener('ended', done);
        standby.el.removeEventListener('pause', onPause);
        resolve();
      };

      // A newer click pauses this clip. Resolve so the old walk unwinds instead
      // of hanging forever on an 'ended' that will never fire.
      const onPause = () => { if (walkToken !== startedAt) done(); };

      standby.el.addEventListener('ended', done, { once: true });
      standby.el.addEventListener('pause', onPause);

      // A failed load shouldn't hang the walkthrough forever.
      standby.el.addEventListener('error', done, { once: true });

      if (standby.src === src && standby.el.readyState >= 2) {
        start();
      } else {
        standby.src = src;
        standby.el.src = src;
        standby.el.addEventListener('canplay', start, { once: true });
        standby.el.load();
      }
    });
  }

  /* Loads a clip onto whichever slot isn't on screen, so it's decodable before
     it's needed. No-op if that slot already holds it. */
  function prewarm(remoteUrl) {
    if (!remoteUrl) return;
    const src = localSrc(remoteUrl);
    const standby = slots[1 - activeSlot];
    if (standby.src === src) return;
    standby.src = src;
    standby.el.src = src;
    standby.el.load();
  }

  /* ---------- loading ---------- */

  /* Downloads EVERY clip before the walkthrough opens.
   *
   * Unlike the Interactive tab (which can reveal after clip 1 and stream the
   * rest, because scrubbing moves gradually), this player jumps a whole room
   * per click. A clip that hasn't arrived yet would stall the walk mid-move,
   * so the loading screen waits for all of them.
   *
   * Each blob is held in memory for the session, so playback never touches the
   * network again. With storage consent they're also written to Cache Storage,
   * making the next visit instant. */
  async function preload() {
    const urls = rooms.map((r) => r.video).filter(Boolean);
    if (!urls.length) return;

    // Drop any cached copy of these clips that isn't the current version, so a
    // replaced video is picked up instead of the stale one.
    if (window.VideoCache && window.VideoCache.pruneStale) {
      await window.VideoCache.pruneStale(urls).catch(() => {});
    }

    // Byte-accurate progress: a clip-count bar jumps in big steps and sits at
    // 0% through the whole first download.
    const sizes = await Promise.all(urls.map(headSize));
    const total = sizes.reduce((a, b) => a + b, 0);
    const got = urls.map(() => 0);

    const paint = () => {
      // Clamp per-clip: a clip served from cache reports its full size at once,
      // and an unknown HEAD size would otherwise let `done` exceed `total` and
      // make the percentage meaningless.
      const done = got.reduce((sum, n, i) => sum + Math.min(n, sizes[i] || n), 0);
      const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
      els.loaderFill.style.width = `${pct}%`;
      els.loaderLabel.textContent = total
        ? `Downloading walkthrough… ${pct}% · ${formatMB(done)} / ${formatMB(total)}`
        : 'Downloading walkthrough…';
    };
    paint();

    // Fetch them all at once and wait for the lot. allSettled so one bad clip
    // can't strand the viewer on the loading screen forever.
    await Promise.allSettled(
      urls.map((url, i) =>
        fetchWithProgress(url, (bytes) => { got[i] = bytes; paint(); })
          .then((blobUrl) => { if (blobUrl) blobUrls.set(url, blobUrl); })
      )
    );

    // Every clip is in memory now. Show a real, filled 100% and let it land
    // before the walkthrough opens — jumping straight from ~90% to playing
    // makes the bar look like it never finished.
    els.loaderFill.style.width = '100%';
    els.loaderLabel.textContent = total
      ? `Ready · ${formatMB(total)}`
      : 'Ready';
    await new Promise((r) => setTimeout(r, 450));

    cacheIfAllowed(urls);
  }

  /* Streams one clip, reporting bytes as they arrive, and returns a blob: URL
     so playback is served from memory rather than re-requested. */
  async function fetchWithProgress(url, onBytes) {
    // Already saved from a previous visit? Use it and skip the network.
    if (window.VideoCache && window.VideoCache.available()) {
      try {
        const cached = await window.VideoCache.blobUrlFromCache(url);
        if (cached) {
          // Report the real size, not Infinity — the progress maths sums these
          // and an infinite term makes the percentage meaningless.
          const size = await fetch(cached).then((r) => r.blob()).then((b) => b.size).catch(() => 0);
          onBytes(size);
          return cached;
        }
      } catch { /* fall through to network */ }
    }

    const res = await fetch(url);
    if (!res.ok || !res.body) {
      const blob = await res.blob();
      onBytes(blob.size);
      return URL.createObjectURL(blob);
    }

    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onBytes(received);
    }
    return URL.createObjectURL(new Blob(chunks, { type: 'video/mp4' }));
  }

  function headSize(url) {
    return fetch(url, { method: 'HEAD' })
      .then((r) => Number(r.headers.get('Content-Length')) || 0)
      .catch(() => 0);
  }

  function formatMB(bytes) {
    if (!isFinite(bytes)) return '';
    return `${(bytes / 1024 / 1024).toFixed(0)}MB`;
  }

  /* The clips are already downloaded in full by the time this runs — writing
     them to Cache Storage costs no extra bandwidth and makes the next visit
     load from disk. No prompt: the download isn't optional, so asking
     permission to keep what we just fetched would only add a click. */
  function cacheIfAllowed(urls) {
    if (window.VideoCache && window.VideoCache.available()) {
      window.VideoCache.downloadToCache(urls).catch(() => {});
    }
  }

  function revealSite() {
    els.loader.classList.add('hidden');
    setTimeout(() => { els.loader.style.display = 'none'; }, 650);
  }

  function showError(err) {
    const panel = document.getElementById('walkthrough-error');
    const text = document.getElementById('walkthrough-error-text');
    if (!panel || !text) throw err;

    const expected = window.WalkthroughError && err instanceof window.WalkthroughError;
    text.textContent = expected ? err.message : 'Something went wrong loading this walkthrough.';
    if (!expected) console.error(err);

    if (els.loader) els.loader.style.display = 'none';
    panel.classList.add('show');
  }
})();
