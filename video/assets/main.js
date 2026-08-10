/* Lion Rock — Video Walkthrough
 *
 * Click-driven, not scroll-driven. Each room has a forward clip and (once
 * uploaded) a pre-rendered reversed clip, because no browser can play a
 * <video> backwards.
 *
 * The rule, from the spec:
 *   • Click a LATER room  → play that room's forward clip.
 *   • Click an EARLIER room → play the CURRENT room's reversed clip first,
 *     then the target's forward clip. Walking back out of the room you're in,
 *     then into the one you asked for.
 *
 * Moving more than one room away chains the same logic, so going from Bedroom 2
 * back to Living reverses out through each room in between.
 */

(() => {
  'use strict';

  const els = {
    loader: document.getElementById('loader'),
    loaderVideo: document.getElementById('loader-video'),
    loaderFill: document.getElementById('loader-bar-fill'),
    loaderLabel: document.getElementById('loader-label'),
    nav: document.getElementById('room-nav'),
    stage: document.getElementById('stage'),
    videoA: document.getElementById('video-a'),
    videoB: document.getElementById('video-b'),
    footerNote: document.getElementById('footer-note'),
  };

  let rooms = [];
  let activeIndex = 0;
  let busy = false;          // a transition is playing (nav shows a destination)
  let walkToken = 0;         // bumped per click; an older walk sees it and stops

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

    // Open on the first room: play it through once, then hold on its last
    // frame waiting for a nav click.
    await playClip(rooms[0].video);
    highlight(0);
  }

  function applyChrome(property) {
    els.footerNote.textContent = property.footerNote || '';
    if (property.loaderVideo) {
      els.loaderVideo.src = property.loaderVideo;
      els.loaderVideo.play().catch(() => {});
    }
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
    highlight(0);
  }

  function highlight(index) {
    rooms.forEach((room, i) => {
      if (room.navLink) room.navLink.classList.toggle('active', i === index);
    });
  }

  /* Locks the nav while a clip plays. `pending` marks the room being travelled
     to, so the viewer can see where the walk is heading before it arrives. */
  function setNavBusy(state, pendingIndex) {
    busy = state;
    rooms.forEach((room, i) => {
      if (!room.navLink) return;
      room.navLink.classList.toggle('busy', state);
      room.navLink.classList.toggle('pending', state && i === pendingIndex);
    });
  }

  /* ---------- the transition rule ---------- */

  async function goToRoom(target) {
    if (target === activeIndex) return;

    // A click during a walk takes over: the running walk is cancelled and a new
    // one starts from wherever we've actually reached. The token is how the old
    // loop finds out — it can't be aborted mid-await, so it checks after every
    // clip and bails if it's been superseded.
    const myWalk = ++walkToken;

    // Stop whatever is mid-play, so the interrupted clip doesn't keep running
    // (and firing 'ended') underneath the new walk.
    slots.forEach((s) => { if (!s.el.paused) s.el.pause(); });

    setNavBusy(true, target);

    const superseded = () => myWalk !== walkToken;

    try {
      if (target > activeIndex) {
        // Forward: just play each room's forward clip in turn.
        for (let i = activeIndex + 1; i <= target; i++) {
          await playClip(rooms[i].video);
          if (superseded()) return;
          activeIndex = i;
          highlight(i);
        }
      } else {
        // Backward, per the spec: play the reversed clip of the room being
        // LEFT (walking back out of it), then the forward clip of the room
        // being ENTERED. Both, in that order — playing only the reverse would
        // leave the viewer looking at the wrong room.
        for (let i = activeIndex; i > target; i--) {
          const back = rooms[i].reverse;
          if (back) {
            await playClip(back);            // walk back out of room i
            if (superseded()) return;
          }
          await playClip(rooms[i - 1].video); // then walk into room i-1
          if (superseded()) return;
          activeIndex = i - 1;
          highlight(activeIndex);
        }
      }
    } finally {
      // Only the newest walk owns the nav state — an old, superseded loop
      // must not unlock the nav out from under the one that replaced it.
      if (!superseded()) setNavBusy(false);
    }
  }

  /* Plays one clip start to finish on the standby slot, swaps it in, and
     resolves when it ends (holding on the last frame). */
  function playClip(remoteUrl) {
    const startedAt = walkToken;   // so an interrupted clip can stop waiting

    return new Promise((resolve) => {
      if (!remoteUrl) { resolve(); return; }

      const src = localSrc(remoteUrl);   // preloaded blob, never the network
      const standbyIdx = 1 - activeSlot;
      const standby = slots[standbyIdx];

      const start = () => {
        standby.el.currentTime = 0;

        // Swap only once the new clip has actually painted its first frame.
        // Swapping on play() alone can show a blank element for a frame or two,
        // which on a short reverse clip eats the part you most need to see.
        const reveal = () => {
          slots[activeSlot].el.classList.remove('active');
          standby.el.classList.add('active');
          activeSlot = standbyIdx;
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

  /* ---------- loading ---------- */

  /* Downloads EVERY clip before the walkthrough opens.
   *
   * Unlike the Interactive tab (which can reveal after clip 1 and stream the
   * rest, because scrubbing moves gradually), this player jumps a whole room
   * per click. A clip that hasn't arrived yet would stall the walk mid-move,
   * so the loading screen waits for all of them — forward and reversed.
   *
   * Each blob is held in memory for the session, so playback never touches the
   * network again. With storage consent they're also written to Cache Storage,
   * making the next visit instant. */
  async function preload() {
    const urls = [];
    rooms.forEach((r) => {
      if (r.video) urls.push(r.video);
      if (r.reverse) urls.push(r.reverse);
    });
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
      const done = got.reduce((a, b) => a + b, 0);
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

    els.loaderFill.style.width = '100%';
    els.loaderLabel.textContent = 'Ready';

    cacheIfAllowed(urls);
  }

  /* Streams one clip, reporting bytes as they arrive, and returns a blob: URL
     so playback is served from memory rather than re-requested. */
  async function fetchWithProgress(url, onBytes) {
    // Already saved from a previous visit? Use it and skip the network.
    if (window.VideoCache && window.VideoCache.available()) {
      try {
        const cached = await window.VideoCache.blobUrlFromCache(url);
        if (cached) { onBytes(Infinity); return cached; }
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

  function cacheIfAllowed(urls) {
    try {
      if (localStorage.getItem('lionrock-cache-consent') !== 'allow') return;
    } catch { return; }
    if (window.VideoCache && window.VideoCache.available()) {
      window.VideoCache.downloadToCache(urls).catch(() => {});
    }
  }

  function revealSite() {
    els.loader.classList.add('hidden');
    setTimeout(() => {
      els.loaderVideo.pause();
      els.loader.style.display = 'none';
    }, 650);
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
