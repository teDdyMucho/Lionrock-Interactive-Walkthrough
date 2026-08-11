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
  const SEEK_THRESHOLD = IS_TOUCH_DEVICE ? 0.05 : 0.02; // seconds of drift before bothering to re-seek
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
    loaderVideo: document.getElementById('loader-video'),
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

  let scrubEngineActive = false;

  init();

  async function init() {
    const data = await fetch('/2209-Branch-Ave-Anoka-MN-55303/content/rooms.json', { cache: 'no-store' }).then(r => r.json());

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
  }

  function applyPropertyChrome(property) {
    if (property.logoLink) els.brandLink.href = property.logoLink;
    els.footerNote.textContent = property.footerNote || '';
    if (property.introVideo) {
      els.loaderVideo.src = property.introVideo;
      els.loaderVideo.play().catch(() => {});
    }
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

  function jumpToRoom(index) {
    velocity = 0;
    glideTarget = clamp(rooms[index].cumStart + 0.05, 0, totalDuration);
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

    const updateProgress = () => {
      const avg = progress.reduce((a, b) => a + b, 0) / total;
      const pct = Math.round(avg * 100);
      els.loaderFill.style.width = `${pct}%`;
      els.loaderLabel.textContent = `Loading walkthrough… ${pct}%`;
    };

    const blobs = await Promise.all(
      rooms.map((room, i) => fetchBlobWithProgress(room.video, (p) => {
        progress[i] = p;
        updateProgress();
      }))
    );

    rooms.forEach((room, i) => { room.blobUrl = blobs[i]; });

    // read each clip's duration once via a single throwaway <video> probe
    const probe = document.createElement('video');
    probe.muted = true;
    probe.playsInline = true;
    for (const room of rooms) {
      await new Promise((resolve) => {
        const done = () => resolve();
        probe.addEventListener('loadedmetadata', () => {
          room.duration = probe.duration || 0;
          done();
        }, { once: true });
        probe.addEventListener('error', done, { once: true });
        probe.src = room.blobUrl;
        probe.load();
      });
    }

    let acc = 0;
    rooms.forEach((room) => { room.cumStart = acc; acc += room.duration; });
    totalDuration = acc;
  }

  function fetchBlobWithProgress(url, onProgress) {
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
    const targetIndex = activeIndex + lastDirection;
    if (targetIndex < 0 || targetIndex >= rooms.length) return;
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
    lastDirection = index > activeIndex ? 1 : -1;
    activeIndex = index;

    const standbyIdx = 1 - activeSlot;
    const standby = slots[standbyIdx];
    const myToken = ++swapToken;

    const finishSwap = () => {
      if (myToken !== swapToken) return; // superseded by a later switchToRoom call
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
      els.loaderVideo.pause();
      els.loader.style.display = 'none';
      maybeShowFullscreenModal();
    }, 650);
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

    if (video.paused) video.play().catch(() => {});
    video.playbackRate = rate;

    if (video.currentTime >= room.duration - ROOM_END_EPSILON || video.ended) {
      // clip's basically done - hand off to the next room (or loop back to the intro)
      const nextIndex = (activeIndex + 1) % rooms.length;
      switchToRoom(nextIndex, 0);
      video = activeVideo();
      room = rooms[activeIndex];
      if (velocity > VELOCITY_EPSILON) {
        video.play().catch(() => {});
        video.playbackRate = rate;
      }
    }
  }

  function backwardSeekStep() {
    pauseActive();
    let next = globalCurrent + velocity; // velocity is negative here
    velocity *= FRICTION;
    if (Math.abs(velocity) < VELOCITY_EPSILON) velocity = 0;
    if (next < 0) { next = 0; velocity = 0; }
    globalCurrent = next;
    seekActiveTo(globalCurrent);
  }

  function easeLoop() {
    if (totalDuration) {
      if (glideTarget !== null) {
        pauseActive();
        globalCurrent += (glideTarget - globalCurrent) * GLIDE_EASE;
        if (Math.abs(glideTarget - globalCurrent) < GLIDE_EPSILON) {
          globalCurrent = glideTarget;
          glideTarget = null;
        }
        seekActiveTo(globalCurrent);
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
