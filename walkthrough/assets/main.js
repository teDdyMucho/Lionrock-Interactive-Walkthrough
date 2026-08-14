(() => {
  'use strict';

  // Motion is velocity/friction based (momentum), not a fixed target-lerp: each
  // scroll/swipe adds an impulse to a velocity, which decays every frame under
  // FRICTION. That's what gives the "plays a few frames at speed, then eases to
  // a stop" glide instead of a hard cut whenever the input stops.
  // Touch/coarse-pointer devices (phones) get gentler motion and a bigger seek
  // dead-zone than desktop - mobile decoders are slower, so fewer/smaller seeks
  // per second matters more for smoothness there than it does on a desktop GPU.
  const IS_TOUCH_DEVICE = window.matchMedia('(hover: none) and (pointer: coarse)').matches;

  // How far one flick travels is roughly velocity / (1 - FRICTION), then capped by
  // MAX_PLAYBACK_RATE. Both matter: sensitivity alone barely moves the needle,
  // because a single trackpad flick fires dozens of wheel events and pins velocity
  // at MAX_VELOCITY within the first few regardless.
  const SCRUB_SENSITIVITY = 0.0006;               // velocity impulse per wheel delta unit
  const TOUCH_SENSITIVITY = 0.0018;               // velocity impulse per pixel of touch swipe
  const FRICTION = 0.94;                          // per-frame velocity decay (0-1, higher = glides longer)
  const MAX_VELOCITY = IS_TOUCH_DEVICE ? 0.12 : 0.15; // forward cap - just becomes a playbackRate, so generous is fine
  // Backward has no real playback, only seeking, so its jumps cost real decode time -
  // capped tighter than forward so each seek is smaller/cheaper, at the cost of feeling
  // more limited when flicking hard backward.
  const MAX_BACKWARD_VELOCITY = IS_TOUCH_DEVICE ? 0.05 : 0.08;
  const VELOCITY_EPSILON = 0.0004;                // velocity below this is treated as stopped
  // Seeks are decoder-paced (see seekActivePaced), so this is only about how
  // much drift is worth a seek at all. Slightly larger than a single frame -
  // sub-frame corrections cost a full decode and aren't visible.
  const SEEK_THRESHOLD = IS_TOUCH_DEVICE ? 0.06 : 0.034;
  // Below this rate, motion is essentially imperceptible - rather than clamping the
  // rate up to this floor and continuing to "play" a near-frozen video for a long
  // tail, forward motion just stops outright once decaying velocity would cross it.
  const MIN_PLAYBACK_RATE = 0.35;                 // forward motion: real <video> playback, not seeking
  // The real ceiling on forward speed: rate is velocity * 60, so anything above
  // MAX_PLAYBACK_RATE / 60 of velocity is just headroom that sustains top speed
  // for longer. Kept lower on touch - mobile decoders drop frames at high rates.
  const MAX_PLAYBACK_RATE = IS_TOUCH_DEVICE ? 5 : 6; // (there's no such thing as reverse playback, so
                                                   // backward motion still has to seek - see easeLoop)
  const ROOM_END_EPSILON = 0.05;                   // seconds from a clip's end that counts as "arrived"
  const GLIDE_EASE = 0.12;                        // how quickly a nav/dot jump eases into its target
  const GLIDE_EPSILON = 0.01;                     // seconds - how close counts as "arrived" for a glide
  const FETCH_TIMEOUT = 20000;                    // ms before the loader gives up waiting on a slow download

  const els = {
    loader: document.getElementById('loader'),
    loaderFill: document.getElementById('loader-bar-fill'),
    loaderLabel: document.getElementById('loader-label'),
    header: document.getElementById('site-header'),
    brandLink: document.getElementById('brand-link'),
    headerRight: document.getElementById('header-right'),
    nav: document.getElementById('room-nav'),
    backToGallery: document.getElementById('back-to-gallery'),
    dotNav: document.getElementById('dot-nav'),
    stage: document.getElementById('stage'),
    videoA: document.getElementById('video-a'),
    videoB: document.getElementById('video-b'),
    footerNote: document.getElementById('footer-note'),
    fullscreenModal: document.getElementById('fullscreen-modal'),
    fullscreenContinue: document.getElementById('fullscreen-continue'),
  };

  // rooms: [{ id, label, video, duration, cumStart, blobUrl }]
  let rooms = [];
  let totalDuration = 0;
  let allRoomsLoaded = null; // resolves once every clip has downloaded + been measured

  let globalCurrent = 0;  // seconds along the whole concatenated timeline
  let velocity = 0;       // seconds/frame, decays under FRICTION - drives momentum scrubbing
  let glideTarget = null; // non-null while easing toward a nav/dot-triggered jump
  let activeIndex = 0;    // which room is currently on screen
  let lastDirection = 1;

  // two video elements ping-pong as the "visible" / "standby" slot so swapping
  // rooms never has to wait on a fresh network load
  const slots = [
    { el: els.videoA, roomIndex: -1, ready: false },
    { el: els.videoB, roomIndex: -1, ready: false },
  ];
  let activeSlot = 0;

  /* A room-end handoff can take several frames to land (the standby clip has to
     report loadedmetadata). Re-requesting it every frame in the meantime bumps
     swapToken each time, and each bump supersedes the pending finishSwap from
     the frame before - starving the swap it was trying to make. So once one is
     in flight, leave it alone. See requestHandoff. */
  let handoffPending = false;

  let scrubEngineActive = false;

  init();

  async function init() {
    // Only difference from the per-project engine: rooms come from Supabase
    // (keyed by ?property=<slug>) instead of a static rooms.json.
    let data;
    try {
      data = await loadRoomsFromSupabase();
    } catch (err) {
      showWalkthroughError(err);
      return;
    }

    applyPropertyChrome(data.property);
    buildRoomsMeta(data.property, data.rooms);
    wireNav();
    wireDotNav();

    fitHeaderNav();
    window.addEventListener('resize', fitHeaderNav);
    window.addEventListener('orientationchange', () => setTimeout(fitHeaderNav, 50));

    await preloadAll();
    setupInitialStage();
    startScrubEngine();
    revealSite();

    // Deliberately not awaited: caching happens after the walkthrough is
    // already playing, so saving for offline never delays the first frame.
    cacheInBackground(rooms.map((r) => r.video).filter(Boolean));
  }

  /* ---------- Automatic offline caching ---------- */

  /* Every clip is written to Cache Storage in the background, so the next visit
     loads from disk. No prompt: the walkthrough downloads these clips either
     way, so keeping them costs nothing extra. Entirely best-effort — a failure
     (quota, unsupported browser) never interrupts the walkthrough. */
  function shouldCacheVideos() {
    return !!(window.VideoCache && window.VideoCache.available());
  }

  async function cacheInBackground(urls) {
    if (!shouldCacheVideos() || !urls.length) return;
    try {
      await window.VideoCache.downloadToCache(urls);
    } catch {
      /* out of space / blocked — the walkthrough still works online */
    }
  }

  /* Replaces the loader with a readable message. Without this the page sits on
     "Loading walkthrough… 0%" forever whenever the property has no videos. */
  function showWalkthroughError(err) {
    const panel = document.getElementById('walkthrough-error');
    const text = document.getElementById('walkthrough-error-text');
    if (!panel || !text) throw err;

    const expected = window.WalkthroughError && err instanceof window.WalkthroughError;
    text.textContent = expected ? err.message : 'Something went wrong loading this walkthrough.';
    if (!expected) console.error(err);

    const loader = document.getElementById('loader');
    if (loader) loader.style.display = 'none';
    panel.classList.add('show');
  }

  function applyPropertyChrome(property) {
    if (property.logoLink) els.brandLink.href = property.logoLink;
    els.footerNote.textContent = property.footerNote || '';
    // No loader backdrop — the download screen stays black on purpose.
  }

  function buildRoomsMeta(property, roomDefs) {
    const usedSlugs = new Set();
    const named = roomDefs.map((def) => ({
      id: uniqueSlug(def.label, usedSlugs),
      label: def.label,
      video: def.video,
      duration: 0,
      cumStart: 0,
      blobUrl: null,
      hidden: false,
    }));

    // the intro plays first and is where the loop lands after the last room -
    // it isn't a nav-jumpable "room" so it gets no nav link / dot
    const intro = property.introVideo ? [{
      id: 'intro',
      label: 'Intro',
      video: property.introVideo,
      duration: 0,
      cumStart: 0,
      blobUrl: null,
      hidden: true,
    }] : [];

    rooms = [...intro, ...named];
  }

  function wireNav() {
    rooms.forEach((room, i) => {
      if (room.hidden) return;
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = room.label;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        jumpToRoom(i);
      });
      els.nav.appendChild(a);
      room.navLink = a;
    });
  }

  function wireDotNav() {
    rooms.forEach((room, i) => {
      if (room.hidden) return;
      const row = document.createElement('div');
      row.className = 'dot-row';

      const label = document.createElement('span');
      label.className = 'dot-label';
      label.textContent = room.label;

      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'dot';
      dot.setAttribute('aria-label', room.label);
      dot.addEventListener('click', () => jumpToRoom(i));

      row.appendChild(label);
      row.appendChild(dot);
      els.dotNav.appendChild(row);
      room.dotRow = row;
    });
  }

  // The nav's DOM order (Exterior ... Bedroom 2, then the gallery link) already
  // reads right-to-left the way it should: the gallery link sits at the header's
  // right edge, Bedroom 2 immediately to its left, on down to Exterior furthest
  // left. This just shrinks the nav's font-size (never the gallery link or logo)
  // so that natural order never overlaps either of them, instead of clipping or
  // requiring a scroll.
  const NAV_MIN_SCALE = 0.55;

  function fitHeaderNav() {
    if (!els.header || !els.nav || !els.brandLink) return;

    els.nav.style.removeProperty('--nav-font-size');
    const baseFontSize = parseFloat(getComputedStyle(els.nav.querySelector('a') || els.nav).fontSize) || 16;

    const galleryWidth = els.backToGallery ? els.backToGallery.offsetWidth + 16 : 0;
    const available = els.header.clientWidth - els.brandLink.offsetWidth - galleryWidth - 48; // 48 = buffer for header padding/gaps
    const required = els.nav.scrollWidth;

    if (available > 0 && required > available) {
      const scale = Math.max(NAV_MIN_SCALE, available / required);
      els.nav.style.setProperty('--nav-font-size', `${baseFontSize * scale}px`);
    }
  }

  /* A nav/dot click shows that room's clip, full stop. No transition, no glide,
     no play-in: the point of the nav is to answer "show me this room", and any
     animation between the click and the answer just delays it and creates a
     window where the previous room is still what you're looking at.

     (Scrolling is untouched: that still scrubs frame by frame, which is the
     point of this player.) */
  function jumpToRoom(index) {
    velocity = 0;
    glideTarget = null;

    const room = rooms[index];
    if (!room) return;

    globalCurrent = clamp(room.cumStart, 0, totalDuration);
    highlightActive(index);   // nav answers the click straight away
    switchToRoom(index, 0);   // and the clicked room's own clip goes on screen
  }

  function highlightActive(index) {
    rooms.forEach((room, i) => {
      room.navLink?.classList.toggle('active', i === index);
      if (!room.dotRow) return;
      room.dotRow.classList.remove('active', 'label-above', 'label-below');
      room.dotRow.classList.add(i === index ? 'active' : i < index ? 'label-above' : 'label-below');
    });
  }

  // ---------- Cache loader (downloads every clip up front so scrubbing never stalls) ----------

  async function preloadAll() {
    const total = rooms.length;
    const progress = rooms.map(() => 0);

    // Wait for EVERY clip before revealing. Gating on room 1 alone let the
    // viewer scrub into a room whose video hadn't arrived, which stalls the
    // playhead — the lag this is meant to remove. Downloading the whole set up
    // front costs one wait instead of a stutter at every room boundary.
    const sizes = await Promise.all(rooms.map((r) => headSize(r.video)));
    const totalBytes = sizes.reduce((a, b) => a + b, 0);

    const updateProgress = () => {
      // Byte-accurate: a per-clip average jumps in big steps and misrepresents
      // how much is actually left.
      const done = progress.reduce((sum, frac, i) => sum + frac * (sizes[i] || 0), 0);
      const pct = totalBytes ? Math.min(100, Math.round((done / totalBytes) * 100)) : 0;
      els.loaderFill.style.width = `${pct}%`;
      els.loaderLabel.textContent = totalBytes
        ? `Downloading walkthrough… ${pct}% · ${formatMB(done)} / ${formatMB(totalBytes)}`
        : `Loading walkthrough… ${pct}%`;
    };
    updateProgress();

    const fetchRoom = (room, i) =>
      fetchBlobWithProgress(room.video, (p) => {
        progress[i] = p;
        updateProgress();
      });

    const pending = rooms.map((room, i) => fetchRoom(room, i));

    pending.forEach((p, i) => {
      p.then((blobUrl) => {
        rooms[i].blobUrl = blobUrl;
        rooms[i].ready = true;
      }).catch(() => { rooms[i].ready = false; });
    });

    await Promise.allSettled(pending);

    // Show a real, filled 100% before the walkthrough opens.
    els.loaderFill.style.width = '100%';
    els.loaderLabel.textContent = totalBytes ? `Ready · ${formatMB(totalBytes)}` : 'Ready';
    await new Promise((r) => setTimeout(r, 450));

    // Every clip is in memory, so measure them all now. Previously durations
    // arrived one at a time and the timeline kept shifting under the viewer;
    // measuring up front means the full scroll length is correct immediately.
    for (const room of rooms) {
      if (!room.blobUrl || room.duration) continue;
      room.duration = await probeDuration(room.blobUrl);
    }
    recomputeTimeline();
    allRoomsLoaded = Promise.resolve();
  }

  function headSize(url) {
    return fetch(url, { method: 'HEAD' })
      .then((r) => Number(r.headers.get('Content-Length')) || 0)
      .catch(() => 0);
  }

  function formatMB(bytes) {
    return `${(bytes / 1024 / 1024).toFixed(0)}MB`;
  }

  /* Reads one clip's duration via a throwaway <video>. */
  function probeDuration(blobUrl) {
    return new Promise((resolve) => {
      const probe = document.createElement('video');
      probe.muted = true;
      probe.playsInline = true;
      probe.addEventListener('loadedmetadata', () => resolve(probe.duration || 0), { once: true });
      probe.addEventListener('error', () => resolve(0), { once: true });
      probe.src = blobUrl;
      probe.load();
    });
  }

  /* Called once with only room 1 measured, then again once every clip has
     landed. Rooms with no duration yet contribute nothing to the timeline, so
     the scrub engine can't land inside a zero-width slot - but they stay in the
     nav so the room list never visibly changes under the viewer. */
  function recomputeTimeline() {
    const anchor = rooms[activeIndex];
    const offsetInRoom = anchor ? globalCurrent - anchor.cumStart : 0;

    let acc = 0;
    rooms.forEach((room) => {
      room.cumStart = acc;
      acc += room.duration || 0;
    });
    totalDuration = acc;

    // Keep the viewer where they are: cumStart shifts as earlier rooms gain
    // real durations, so re-anchor rather than letting position jump.
    if (anchor) globalCurrent = anchor.cumStart + offsetInRoom;
  }

  function fetchBlobWithProgress(url, onProgress) {
    // A previously saved clip comes straight from Cache Storage — no network,
    // works offline. Falls through to the normal fetch when it isn't stored.
    return cachedBlobFirst(url, onProgress);
  }

  async function cachedBlobFirst(url, onProgress) {
    if (window.VideoCache && window.VideoCache.available()) {
      try {
        const blobUrl = await window.VideoCache.blobUrlFromCache(url);
        if (blobUrl) {
          onProgress(1);
          return blobUrl;
        }
      } catch { /* fall through to network */ }
    }
    return networkBlobWithProgress(url, onProgress);
  }

  function networkBlobWithProgress(url, onProgress) {
    return Promise.race([
      fetch(url).then(async (response) => {
        const contentLength = Number(response.headers.get('Content-Length')) || 0;
        if (!response.body || !contentLength) {
          const blob = await response.blob();
          onProgress(1);
          return URL.createObjectURL(blob);
        }
        const reader = response.body.getReader();
        const chunks = [];
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          onProgress(Math.min(1, received / contentLength));
        }
        return URL.createObjectURL(new Blob(chunks));
      }),
      new Promise((resolve) => setTimeout(() => { onProgress(1); resolve(null); }, FETCH_TIMEOUT)),
    ]);
  }

  // ---------- Stage: two ping-ponging <video> elements ----------

  function setupInitialStage() {
    const first = slots[0];
    first.roomIndex = 0;
    first.el.src = rooms[0].blobUrl;
    first.el.load();
    first.el.classList.add('active');
    activeSlot = 0;
    activeIndex = 0;
    highlightActive(0);
    prewarmNeighbor();
  }

  function prewarmNeighbor() {
    // Forward wraps to the intro so the last room's handoff finds its target
    // already in standby, same as every other boundary - otherwise that one
    // transition always took the slow async path.
    const targetIndex = lastDirection > 0
      ? (activeIndex + 1) % rooms.length
      : activeIndex - 1;
    if (targetIndex < 0 || targetIndex >= rooms.length) return;
    if (!rooms[targetIndex].blobUrl) return; // still downloading — nothing to prewarm yet
    const standby = slots[1 - activeSlot];
    if (standby.roomIndex === targetIndex) return;
    standby.roomIndex = targetIndex;
    standby.ready = false;
    standby.el.src = rooms[targetIndex].blobUrl;
    standby.el.load();
    standby.el.addEventListener('loadedmetadata', () => { standby.ready = true; }, { once: true });
  }

  // A fast glide (nav/dot click) can cross several room boundaries within one
  // video's load time, calling switchToRoom again before an earlier call's
  // "loadedmetadata" has fired. That listener stays attached and still fires
  // later against whatever src is *actually* loaded by then - without this
  // token guard, its stale index/localTime would land the swap on the wrong
  // spot. Only the most recent request's callback is allowed to apply itself.
  let swapToken = 0;

  function switchToRoom(index, localTime) {
    // The site reveals after room 1, so a later room can still be downloading.
    // Staying put beats swapping to an empty <video> and showing black.
    if (!rooms[index] || !rooms[index].blobUrl) return;

    // Any new request supersedes a room-end handoff that was still in flight,
    // so the "don't re-request it" latch has to drop with it - otherwise a nav
    // click landing mid-handoff would leave it stuck on forever.
    handoffPending = false;

    lastDirection = index > activeIndex ? 1 : -1;
    activeIndex = index;

    const standbyIdx = 1 - activeSlot;
    const standby = slots[standbyIdx];
    const myToken = ++swapToken;

    const finishSwap = () => {
      if (myToken !== swapToken) return; // superseded by a later switchToRoom call
      handoffPending = false;            // swap landed - boundary is clear again
      standby.el.currentTime = localTime;
      slots[activeSlot].el.pause();
      slots[activeSlot].el.classList.remove('active');
      standby.el.classList.add('active');
      activeSlot = standbyIdx;
      highlightActive(index);
      prewarmNeighbor();
    };

    if (standby.roomIndex === index) {
      finishSwap();
    } else {
      standby.roomIndex = index;
      standby.el.src = rooms[index].blobUrl;
      standby.el.load();
      standby.el.addEventListener('loadedmetadata', finishSwap, { once: true });
      // If the clip fails to load, loadedmetadata never fires - the swap would
      // stay "in flight" forever and freeze the whole engine. Give up on it and
      // fall back to whatever is genuinely on screen.
      standby.el.addEventListener('error', () => {
        if (myToken !== swapToken) return;
        handoffPending = false;
        standby.roomIndex = -1;                      // holds nothing usable
        activeIndex = slots[activeSlot].roomIndex;   // stay with the visible room
        highlightActive(activeIndex);
      }, { once: true });
    }
  }

  function locate(t) {
    for (let i = 0; i < rooms.length; i++) {
      const room = rooms[i];
      if (t < room.cumStart + room.duration || i === rooms.length - 1) {
        return { index: i, localTime: clamp(t - room.cumStart, 0, room.duration) };
      }
    }
    return { index: 0, localTime: 0 };
  }

  function revealSite() {
    els.loader.classList.add('hidden');
    setTimeout(() => {
      els.loader.style.display = 'none';
      maybeShowFullscreenModal();
      // On touch the fullscreen prompt owns the first tap, so the guide waits
      // for it rather than stacking two overlays.
      if (!els.fullscreenModal.classList.contains('visible')) maybeShowGuide();
    }, 650);
  }

  // ---------- First-visit guide ----------

  const GUIDE_SEEN_KEY = 'lionrock-guide-seen';

  /* Four steps: scrub forward, scrub back, jump via the nav, return to the
     gallery. Shown once per browser — a walkthrough people revisit shouldn't
     re-explain itself every time. */
  function maybeShowGuide() {
    const guide = document.getElementById('guide');
    if (!guide) return;

    try {
      if (localStorage.getItem(GUIDE_SEEN_KEY)) return;
    } catch { /* storage blocked — still worth showing once */ }

    // Wording differs by input: you swipe a phone, you scroll a desktop.
    document.getElementById('guide-text-0').textContent =
      IS_TOUCH_DEVICE ? 'Swipe Down to Continue' : 'Scroll Down to Continue';
    document.getElementById('guide-text-1').textContent =
      IS_TOUCH_DEVICE ? 'Swipe Up to Return' : 'Scroll Up to Return';
    document.getElementById('guide-hint').textContent =
      IS_TOUCH_DEVICE ? 'Tap anywhere to continue' : 'Click anywhere to continue';

    const steps = [...guide.querySelectorAll('.guide-step')];
    let index = 0;

    const show = (i) => {
      steps.forEach((s, n) => s.classList.toggle('active', n === i));
      // The pointer steps have to line up with real header elements, whose
      // positions depend on the rendered nav — so measure, don't hardcode.
      if (i === 2) anchorTo(steps[2], els.nav.querySelector('a:nth-child(2)'));
      if (i === 3) anchorTo(steps[3], els.backToGallery);
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

    // Scrolling/swiping while the guide is up would scrub the video behind it.
    // Swallow the gesture and advance instead, so the action being taught is
    // also the action that moves the guide along. Throttled because one flick
    // of a wheel fires dozens of events and would blow through every step.
    let gestureLocked = false;
    const onGuideGesture = (e) => {
      e.preventDefault();
      if (gestureLocked) return;
      gestureLocked = true;
      setTimeout(() => { gestureLocked = false; }, 700);
      advance();
    };
    guide.addEventListener('wheel', onGuideGesture, { passive: false });
    guide.addEventListener('touchmove', onGuideGesture, { passive: false });

    show(0);
    guide.classList.add('show');
    document.body.classList.add('guide-open');
  }

  /* Draws the ring around the element being described and centres the label
     under it. The ring is sized from the target rather than fixed, so it hugs
     a short label ("Living") and a long one ("← Gallery") equally well. */
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

    // The step is a centred column, so give it the ring's width and place it
    // so the ring lands exactly over the target.
    step.style.width = `${ringW}px`;
    step.style.left = `${r.left + r.width / 2 - ringW / 2}px`;
    step.style.top = `${r.top + r.height / 2 - ringH / 2}px`;
    step.style.transform = 'none';
  }

  // Fullscreen can only be requested from within a real tap/click, so on touch
  // devices we ask every load rather than trying (and failing) to trigger it
  // automatically. iOS Safari doesn't support the Fullscreen API at all - the
  // request there is just a no-op and the modal dismisses normally either way.
  function maybeShowFullscreenModal() {
    const isTouch = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    if (!isTouch) return;
    els.fullscreenModal.classList.add('visible');
  }

  els.fullscreenContinue.addEventListener('click', () => {
    const el = document.documentElement;
    const request = el.requestFullscreen || el.webkitRequestFullscreen;
    if (request && !document.fullscreenElement) {
      request.call(el).catch(() => {});
    }
    els.fullscreenModal.classList.remove('visible');
    maybeShowGuide(); // deferred until the fullscreen prompt is out of the way
  });

  // ---------- Scroll-scrub engine ----------

  function startScrubEngine() {
    scrubEngineActive = true;
    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd, { passive: true });
    window.addEventListener('touchcancel', onTouchEnd, { passive: true });
    requestAnimationFrame(easeLoop);
  }

  function onWheel(e) {
    if (!scrubEngineActive || !totalDuration) return;
    e.preventDefault();
    addImpulse(e.deltaY * SCRUB_SENSITIVITY);
  }

  let touchLastX = null;
  let touchLastY = null;

  // The forced-landscape CSS rotates the whole page 90deg, but touch events still
  // report raw physical screen coordinates - they know nothing about that CSS
  // transform. So while rotated, a visual "swipe up" is a physical swipe to the
  // right, not up. Checked live (not cached) since the device can flip orientation
  // mid-session.
  function isForcedLandscape() {
    return window.matchMedia('(max-width:900px) and (orientation:portrait)').matches;
  }

  function onTouchStart(e) {
    touchLastX = e.touches[0].clientX;
    touchLastY = e.touches[0].clientY;
  }

  function onTouchMove(e) {
    if (!scrubEngineActive || !totalDuration || touchLastY === null) return;
    e.preventDefault();
    const x = e.touches[0].clientX;
    const y = e.touches[0].clientY;

    // swipe "up"/"down" as the user visually perceives them = forward/backward,
    // matching wheel-down = forward
    const delta = isForcedLandscape()
      ? x - touchLastX   // rotated 90deg: physical rightward swipe = visual "up"
      : touchLastY - y;  // unrotated: physical upward swipe = visual "up"

    touchLastX = x;
    touchLastY = y;
    addImpulse(delta * TOUCH_SENSITIVITY);
  }

  function onTouchEnd() {
    touchLastX = null;
    touchLastY = null;
  }

  function addImpulse(deltaSeconds) {
    glideTarget = null; // raw input always takes over from a programmatic glide
    const raw = velocity + deltaSeconds;
    velocity = raw >= 0 ? clamp(raw, 0, MAX_VELOCITY) : clamp(raw, -MAX_BACKWARD_VELOCITY, 0);
  }

  // Forward motion plays the video for real (browser-decoded sequential frames -
  // smooth by construction) instead of seeking every frame. Backward motion has
  // no such option - there's no such thing as reverse <video> playback in any
  // browser - so it still seeks, same as before.

  function activeVideo() { return slots[activeSlot].el; }

  /* True while a switchToRoom is still waiting on loadedmetadata: activeIndex
     has already moved to the new room, but the element on screen is still the
     old one. Playing or seeking during that window hits the wrong clip. */
  function swapInFlight() { return slots[activeSlot].roomIndex !== activeIndex; }

  function pauseActive() {
    const video = activeVideo();
    if (!video.paused) video.pause();
  }

  function seekActiveTo(t) {
    const { index, localTime } = locate(t);
    if (index !== activeIndex) {
      switchToRoom(index, localTime);
      return;
    }
    // activeIndex matches, but the swap onto it may not have landed - seeking
    // now would scrub the outgoing room's clip.
    if (swapInFlight()) return;
    const video = activeVideo();
    // skip while a previous seek is still resolving - firing a new one before the
    // decoder catches up is what made playback look choppy/low-framerate
    if (!video.seeking && video.readyState >= 1 && Math.abs(video.currentTime - localTime) > SEEK_THRESHOLD) {
      // fastSeek (where supported) seeks to the nearest keyframe rather than
      // decoding an exact frame - trades a little precision for speed, which is
      // the right trade for continuous backward scrubbing
      if (typeof video.fastSeek === 'function') {
        video.fastSeek(localTime);
      } else {
        video.currentTime = localTime;
      }
    }
  }

  /* Backward scrubbing can only seek, and a seek costs far more than one frame
     of decode. Issuing another before the last one resolves just queues work
     the decoder can't keep up with, which is what reads as stutter. Instead we
     let the *decoder* set the pace: position keeps accumulating every frame
     (so momentum/physics stay frame-accurate), but a new seek is only issued
     once the previous one has actually landed. */
  let seekPending = false;

  function seekActivePaced(t) {
    const { index } = locate(t);
    if (index !== activeIndex) {   // room switches must not be skipped
      seekPending = false;
      seekActiveTo(t);
      return;
    }

    const video = activeVideo();
    if (seekPending && video.seeking) return;  // decoder still busy — skip this frame
    seekPending = false;

    const before = video.currentTime;
    seekActiveTo(t);

    if (video.currentTime !== before || video.seeking) {
      seekPending = true;
      // `seeked` fires once the frame is actually presentable.
      video.addEventListener('seeked', () => { seekPending = false; }, { once: true });
    }
  }

  function refreshGlobalCurrent() {
    const video = activeVideo();
    const room = rooms[activeIndex];
    const t = video.readyState >= 1 ? video.currentTime : 0;
    globalCurrent = room.cumStart + clamp(t, 0, room.duration);
  }

  function forwardPlayStep() {
    const impliedRate = velocity * 60;
    if (impliedRate < MIN_PLAYBACK_RATE) {
      // too slow to look like motion - stop cleanly instead of crawling
      velocity = 0;
      pauseActive();
      return;
    }

    const rate = clamp(impliedRate, MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE);
    velocity *= FRICTION;
    if (velocity < VELOCITY_EPSILON) velocity = 0;

    let video = activeVideo();
    let room = rooms[activeIndex];

    // The boundary is checked BEFORE any play() call, because play() on an
    // element that has already ended seeks it back to zero (HTML spec) - which
    // is exactly how a finished room used to play through a second time.
    if (video.ended || video.currentTime >= room.duration - ROOM_END_EPSILON) {
      // clip's basically done - hand off to the next room (or loop back to the intro)
      const slotBefore = activeSlot;
      requestHandoff();

      if (activeSlot === slotBefore) {
        // Swap hasn't landed: the next clip is still loading, or hasn't even
        // downloaded yet. Hold at the end of this room for now - the swap (or a
        // later retry once the download arrives) resumes motion on a later frame.
        pauseActive();
        return;
      }

      video = activeVideo();
      room = rooms[activeIndex];
    }

    if (video.paused) video.play().catch(() => {});
    video.playbackRate = rate;
  }

  function requestHandoff() {
    if (handoffPending) return;
    const nextIndex = (activeIndex + 1) % rooms.length;
    const slotBefore = activeSlot;
    switchToRoom(nextIndex, 0);
    // Latch only if the switch was actually accepted and is still pending. If it
    // bailed on a missing blobUrl, activeIndex never moved and we want to retry.
    handoffPending = activeIndex === nextIndex && activeSlot === slotBefore;
  }

  function backwardSeekStep() {
    pauseActive();
    let next = globalCurrent + velocity; // velocity is negative here
    velocity *= FRICTION;
    if (Math.abs(velocity) < VELOCITY_EPSILON) velocity = 0;
    if (next < 0) { next = 0; velocity = 0; }
    globalCurrent = next;
    seekActivePaced(globalCurrent);
  }

  function easeLoop() {
    if (totalDuration) {
      if (swapInFlight()) {
        // Room switch still resolving. The element on screen belongs to the
        // room we're leaving, so hold this frame out rather than driving it.
        pauseActive();
      } else if (glideTarget !== null) {
        // A jump now always glides FORWARD within one room, so let the video
        // play instead of seeking: the browser decodes sequential frames, which
        // is smooth by construction. Seeking every frame is what made this
        // look choppy.
        const video = activeVideo();
        const room = rooms[activeIndex];
        const localTarget = clamp(glideTarget - room.cumStart, 0, room.duration);

        if (video.readyState >= 2 && video.currentTime < localTarget) {
          if (video.paused) video.play().catch(() => {});
          video.playbackRate = 1;
          refreshGlobalCurrent();
          if (video.currentTime >= localTarget - 0.05) {
            video.pause();
            glideTarget = null;
          }
        } else {
          // Fallback (metadata not ready, or target is behind us): ease + seek,
          // the original behaviour.
          pauseActive();
          globalCurrent += (glideTarget - globalCurrent) * GLIDE_EASE;
          const arrived = Math.abs(glideTarget - globalCurrent) < GLIDE_EPSILON;
          if (arrived) {
            globalCurrent = glideTarget;
            glideTarget = null;
            seekActiveTo(globalCurrent);
          } else {
            seekActivePaced(globalCurrent);
          }
        }
      } else if (velocity > VELOCITY_EPSILON) {
        forwardPlayStep();
        refreshGlobalCurrent();
      } else if (velocity < -VELOCITY_EPSILON) {
        backwardSeekStep();
      } else {
        pauseActive();
      }
    }
    requestAnimationFrame(easeLoop);
  }

  // ---------- helpers ----------

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  function uniqueSlug(label, usedSlugs) {
    const base = (label || 'room')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || 'room';
    let slug = base;
    let n = 2;
    while (usedSlugs.has(slug)) slug = `${base}-${n++}`;
    usedSlugs.add(slug);
    return slug;
  }
})();
