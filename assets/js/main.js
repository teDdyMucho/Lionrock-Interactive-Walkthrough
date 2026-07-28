(() => {
  'use strict';

  const SCRUB_SENSITIVITY = 0.0026;   // seconds of video per wheel delta unit
  const EASE_FACTOR = 0.12;           // how quickly currentTime eases toward the target (0-1)
  const READY_TIMEOUT = 15000;        // ms before the loader gives up waiting on a slow video
  const EDGE_RELEASE = 0.05;          // seconds of slack at 0/duration before handing scroll back to the page

  const els = {
    loader: document.getElementById('loader'),
    loaderVideo: document.getElementById('loader-video'),
    loaderFill: document.getElementById('loader-bar-fill'),
    loaderLabel: document.getElementById('loader-label'),
    header: document.getElementById('site-header'),
    brandLink: document.getElementById('brand-link'),
    nav: document.getElementById('room-nav'),
    dotNav: document.getElementById('dot-nav'),
    container: document.getElementById('rooms-container'),
    footerNote: document.getElementById('footer-note'),
  };

  let rooms = [];          // render state per room: { id, label, el, video, duration, target, current, navLink, dot }
  let currentIndex = 0;
  let scrubEngineActive = false;

  init();

  async function init() {
    const data = await fetch('content/rooms.json', { cache: 'no-store' }).then(r => r.json());

    applyPropertyChrome(data.property);
    renderRooms(data.property, data.rooms);
    wireNav();
    wireDotNav();
    observeActiveSection();

    await preloadAll();
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

  function renderRooms(property, roomDefs) {
    const usedSlugs = new Set();

    roomDefs.forEach((def, i) => {
      const id = uniqueSlug(def.label, usedSlugs);

      const section = document.createElement('section');
      section.className = 'room-section';
      section.id = `room-${id}`;
      section.dataset.index = String(i);

      const video = document.createElement('video');
      video.src = def.video;
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';

      const label = document.createElement('div');
      label.className = 'room-label';
      label.textContent = def.label;

      section.appendChild(video);
      section.appendChild(label);

      if (i === 0) {
        const hero = document.createElement('div');
        hero.className = 'room-hero';
        hero.innerHTML = `
          <div class="eyebrow">${escapeHtml(property.eyebrow || 'Virtual Walkthrough')}</div>
          <h1>${escapeHtml(property.title || '')}</h1>
          <div class="address">${escapeHtml(property.address || '')}</div>
        `;
        section.appendChild(hero);
      }

      els.container.appendChild(section);

      rooms.push({
        id,
        label: def.label,
        el: section,
        video,
        duration: 0,
        target: 0,
        current: 0,
      });
    });
  }

  function wireNav() {
    rooms.forEach((room, i) => {
      const a = document.createElement('a');
      a.href = `#room-${room.id}`;
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
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'dot';
      dot.setAttribute('aria-label', room.label);
      dot.addEventListener('click', () => jumpToRoom(i));
      els.dotNav.appendChild(dot);
      room.dot = dot;
    });
  }

  function jumpToRoom(index, atEnd = false) {
    const room = rooms[index];
    room.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    room.target = atEnd ? room.duration : 0;
    room.current = room.target;
    if (room.video.readyState >= 1) room.video.currentTime = room.target;
  }

  function setActive(index) {
    if (index === currentIndex && rooms[index]?.navLink?.classList.contains('active')) return;
    currentIndex = index;
    rooms.forEach((room, i) => {
      room.navLink?.classList.toggle('active', i === index);
      room.dot?.classList.toggle('active', i === index);
    });
  }

  function observeActiveSection() {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
          const idx = Number(entry.target.dataset.index);
          setActive(idx);
        }
      });
    }, { threshold: [0.5] });

    rooms.forEach((room) => observer.observe(room.el));
  }

  // ---------- Cache loader ----------

  function preloadAll() {
    const total = rooms.length;
    const progressByRoom = rooms.map(() => 0);

    const updateProgress = () => {
      const avg = progressByRoom.reduce((a, b) => a + b, 0) / total;
      const pct = Math.round(avg * 100);
      els.loaderFill.style.width = `${pct}%`;
      els.loaderLabel.textContent = `Loading walkthrough… ${pct}%`;
    };

    const waitFor = (room, i) => new Promise((resolve) => {
      const { video } = room;
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        room.duration = video.duration || 0;
        room.target = 0;
        room.current = 0;
        progressByRoom[i] = 1;
        updateProgress();
        // force the browser to decode/render the first frame so the initial seek is instant
        video.play().then(() => video.pause()).catch(() => {});
        resolve();
      };

      video.addEventListener('canplaythrough', finish, { once: true });
      video.addEventListener('progress', () => {
        if (video.buffered.length && video.duration) {
          const buffered = video.buffered.end(video.buffered.length - 1);
          progressByRoom[i] = Math.min(1, buffered / video.duration) * 0.95;
          updateProgress();
        }
      });
      video.addEventListener('error', finish, { once: true });
      setTimeout(finish, READY_TIMEOUT);

      video.load();
    });

    return Promise.all(rooms.map(waitFor));
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
    requestAnimationFrame(easeLoop);
  }

  function onWheel(e) {
    if (!scrubEngineActive) return;
    const room = rooms[currentIndex];
    if (!room || !room.duration) return;

    // only scroll-jack while the active room's section actually fills the viewport
    // (e.g. not while the footer below the last room has scrolled into view)
    const rect = room.el.getBoundingClientRect();
    if (rect.top > 1 || rect.bottom < window.innerHeight - 1) return;

    const goingForward = e.deltaY > 0;
    const atStart = room.target <= EDGE_RELEASE;
    const atEnd = room.target >= room.duration - EDGE_RELEASE;

    // let the page scroll naturally once this clip is exhausted: forward always releases
    // (so the last room can scroll on into the footer), backward only releases if there's
    // an earlier room to land on
    if ((goingForward && atEnd) ||
        (!goingForward && atStart && currentIndex > 0)) {
      return;
    }

    e.preventDefault();
    room.target = clamp(room.target + e.deltaY * SCRUB_SENSITIVITY, 0, room.duration);
  }

  function easeLoop() {
    const room = rooms[currentIndex];
    if (room && room.duration) {
      room.current += (room.target - room.current) * EASE_FACTOR;
      if (Math.abs(room.target - room.current) < 0.01) room.current = room.target;
      if (room.video.readyState >= 1 && Math.abs(room.video.currentTime - room.current) > 0.015) {
        room.video.currentTime = room.current;
      }
    }
    requestAnimationFrame(easeLoop);
  }

  // when the page scroll naturally lands on a new section (edge release, or manual scrollbar drag),
  // prime that section's target based on which direction we arrived from
  let lastKnownIndex = 0;
  window.addEventListener('scroll', debounce(() => {
    if (currentIndex === lastKnownIndex) return;
    const arrivingForward = currentIndex > lastKnownIndex;
    const room = rooms[currentIndex];
    if (room) {
      room.target = arrivingForward ? 0 : room.duration;
      room.current = room.target;
      if (room.video.readyState >= 1) room.video.currentTime = room.target;
    }
    lastKnownIndex = currentIndex;
  }, 120), { passive: true });

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

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
})();
