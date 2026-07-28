(() => {
  'use strict';

  const SCRUB_SENSITIVITY = 0.0026;   // seconds of video per wheel delta unit
  const TOUCH_SENSITIVITY = 0.007;    // seconds of video per pixel of touch swipe (swipes are shorter than wheel scrolls)
  const EASE_FACTOR = 0.15;           // how quickly the timeline eases toward the target (0-1)
  const FETCH_TIMEOUT = 20000;        // ms before the loader gives up waiting on a slow download

  const els = {
    loader: document.getElementById('loader'),
    loaderVideo: document.getElementById('loader-video'),
    loaderFill: document.getElementById('loader-bar-fill'),
    loaderLabel: document.getElementById('loader-label'),
    brandLink: document.getElementById('brand-link'),
    nav: document.getElementById('room-nav'),
    dotNav: document.getElementById('dot-nav'),
    stage: document.getElementById('stage'),
    videoA: document.getElementById('video-a'),
    videoB: document.getElementById('video-b'),
    footerNote: document.getElementById('footer-note'),
  };

  // rooms: [{ id, label, video, duration, cumStart, blobUrl }]
  let rooms = [];
  let totalDuration = 0;

  let globalTarget = 0;   // seconds along the whole concatenated timeline
  let globalCurrent = 0;  // eased position
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
    const data = await fetch('content/rooms.json', { cache: 'no-store' }).then(r => r.json());

    applyPropertyChrome(data.property);
    buildRoomsMeta(data.property, data.rooms);
    wireNav();
    wireDotNav();

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

  function jumpToRoom(index) {
    globalTarget = clamp(rooms[index].cumStart + 0.05, 0, totalDuration);
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

  function switchToRoom(index, localTime) {
    lastDirection = index > activeIndex ? 1 : -1;
    activeIndex = index;

    const standbyIdx = 1 - activeSlot;
    const standby = slots[standbyIdx];

    const finishSwap = () => {
      standby.el.currentTime = localTime;
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
    }, 650);
  }

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
    applyScrubDelta(e.deltaY * SCRUB_SENSITIVITY);
  }

  let touchLastY = null;

  function onTouchStart(e) {
    touchLastY = e.touches[0].clientY;
  }

  function onTouchMove(e) {
    if (!scrubEngineActive || !totalDuration || touchLastY === null) return;
    e.preventDefault();
    const y = e.touches[0].clientY;
    const deltaY = touchLastY - y; // swipe up (finger moves up) = forward, matching wheel-down = forward
    touchLastY = y;
    applyScrubDelta(deltaY * TOUCH_SENSITIVITY);
  }

  function onTouchEnd() {
    touchLastY = null;
  }

  function applyScrubDelta(deltaSeconds) {
    let next = globalTarget + deltaSeconds;

    if (next >= totalDuration) {
      // scrolled/swiped past the end - loop back around to the intro instead of stopping
      next %= totalDuration;
      globalCurrent = next; // hard cut so we don't visibly rewind through the whole timeline to get there
    } else if (next < 0) {
      next = 0;
    }

    globalTarget = next;
  }

  function easeLoop() {
    if (totalDuration) {
      globalCurrent += (globalTarget - globalCurrent) * EASE_FACTOR;
      if (Math.abs(globalTarget - globalCurrent) < 0.01) globalCurrent = globalTarget;

      const { index, localTime } = locate(globalCurrent);
      if (index !== activeIndex) {
        switchToRoom(index, localTime);
      } else {
        const video = slots[activeSlot].el;
        // skip while a previous seek is still resolving - firing a new one before the
        // decoder catches up is what made playback look choppy/low-framerate
        if (!video.seeking && video.readyState >= 1 && Math.abs(video.currentTime - localTime) > 0.02) {
          video.currentTime = localTime;
        }
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
