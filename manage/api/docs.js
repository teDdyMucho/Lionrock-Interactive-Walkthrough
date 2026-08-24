/* API documentation page — /manage/api/
 *
 * Gated on being signed in: the page is hidden until AdminAuth confirms a user,
 * so someone who guesses the URL sees nothing.
 *
 * The API key can't be read from the server's environment by a browser, so it's
 * kept per-admin in localStorage. That's deliberate: the real key lives only in
 * the deployment's env vars, and this page just remembers a copy for the "Try
 * it" button and the Copy control. Clearing site data forgets it.
 */

(() => {
  'use strict';

  const KEY_STORE = 'lionrock-api-key';
  const $ = (sel) => document.querySelector(sel);

  const doc = $('#doc');
  const gate = $('#gate');

  /* ---------- auth gate ---------- */

  if (!window.AdminAuth || !window.AdminAuth.available) {
    gate.classList.add('show');
    gate.innerHTML =
      'Supabase isn\'t configured on this deployment, so sign-in can\'t be checked.';
    return;
  }

  window.AdminAuth.getUser().then((user) => {
    if (user) {
      doc.classList.add('ready');
      init();
    } else {
      gate.classList.add('show');
    }
  });

  // Signing out in another tab should hide this immediately.
  window.AdminAuth.onChange((user) => {
    if (!user) {
      doc.classList.remove('ready');
      gate.classList.add('show');
    }
  });

  /* ---------- page ---------- */

  function init() {
    wireCopyButtons();
    wireKeyBox();
    wireTryIt();
    paintReadyCurl();
    useRealHost();
  }

  /* The docs are written against the production domain, but if you're reading
     them on localhost the examples should match what you'd actually call. */
  function useRealHost() {
    const here = location.origin;
    if (here.includes('lionrock-walkthrough.vercel.app')) return;

    document.querySelectorAll('code').forEach((el) => {
      if (el.textContent.includes('https://lionrock-walkthrough.vercel.app')) {
        el.textContent = el.textContent.split('https://lionrock-walkthrough.vercel.app').join(here);
      }
    });
    document.querySelectorAll('td code').forEach((el) => {
      if (el.textContent.includes('https://lionrock-walkthrough.vercel.app')) {
        el.textContent = el.textContent.split('https://lionrock-walkthrough.vercel.app').join(here);
      }
    });
  }

  function flash(btn, text) {
    const original = btn.textContent;
    btn.textContent = text;
    setTimeout(() => { btn.textContent = original; }, 1400);
  }

  async function copy(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      flash(btn, 'Copied');
    } catch {
      // Clipboard needs a secure context; fall back to a selectable prompt.
      window.prompt('Copy:', text);
    }
  }

  function wireCopyButtons() {
    document.querySelectorAll('pre .copy').forEach((btn) => {
      btn.addEventListener('click', () => {
        const code = btn.parentElement.querySelector('code');
        copy(code ? code.textContent : '', btn);
      });
    });
  }

  /* ---------- the key ---------- */

  function storedKey() {
    try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; }
  }

  function storeKey(v) {
    try { localStorage.setItem(KEY_STORE, v); } catch { /* ignore */ }
    paintReadyCurl();
  }

  function wireKeyBox() {
    const box = $('#keybox');
    const reveal = $('#reveal');
    const copyBtn = $('#copykey');

    let shown = false;

    const paint = () => {
      const key = storedKey();
      if (!key) {
        box.textContent = 'Not saved on this device — click Reveal to enter it.';
        box.style.opacity = '.45';
        return;
      }
      box.style.opacity = '1';
      box.textContent = shown ? key : '•'.repeat(Math.min(key.length, 48));
    };

    reveal.addEventListener('click', () => {
      let key = storedKey();

      // First use on this device: ask for it once, then remember.
      if (!key) {
        const entered = window.prompt(
          'Paste the API key (WALKTHROUGH_API_KEY from your Vercel environment).\n\n' +
          'It is stored only in this browser, so you only do this once per device.'
        );
        if (!entered) return;
        key = entered.trim();
        storeKey(key);
        shown = true;
        paint();
        return;
      }

      shown = !shown;
      reveal.textContent = shown ? 'Hide' : 'Reveal';
      paint();
    });

    copyBtn.addEventListener('click', () => {
      const key = storedKey();
      if (!key) { flash(copyBtn, 'No key'); return; }
      copy(key, copyBtn);
    });

    paint();
  }

  /* A copy-paste-ready curl with the real key already substituted. The header
     snippets above are templates (YOUR_KEY), which is easy to paste by mistake
     — this removes that step entirely. */
  function paintReadyCurl() {
    const el = document.getElementById('ready-curl');
    if (!el) return;

    const key = storedKey();
    if (!key) {
      el.textContent = 'Click Reveal above to fill in your key.';
      el.style.opacity = '.5';
      return;
    }

    el.style.opacity = '1';
    // Split across two lines with a trailing backslash, the way a terminal
    // expects, so it stays readable and still pastes as one command.
    el.textContent =
      'curl -H "x-api-key: ' + key + '" \\\n' +
      '  ' + location.origin + '/api/walkthroughs';
  }

  /* ---------- try it ---------- */

  function wireTryIt() {
    const btn = $('#tryit');
    const out = $('#try-output');

    btn.addEventListener('click', async () => {
      const key = storedKey();
      out.classList.add('show');

      if (!key) {
        out.innerHTML = '<span class="bad">No key saved on this device.</span>\n' +
          'Click Reveal above and paste it first.';
        return;
      }

      // Whatever filters are typed in the box, tolerating a leading "?" or not.
      const raw = ($('#tryquery').value || '').trim().replace(/^\?/, '');
      const url = '/api/walkthroughs' + (raw ? `?${raw}` : '');

      out.textContent = `GET ${url}\n\nSending…`;
      btn.disabled = true;

      try {
        const res = await fetch(url, { headers: { 'x-api-key': key } });
        const text = await res.text();

        let pretty = text;
        try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* not JSON */ }

        const cls = res.ok ? 'ok' : 'bad';
        // Echo the URL back so it's obvious which filters actually ran.
        const head = `GET ${escapeHtml(url)}\n<span class="${cls}">HTTP ${res.status}</span>\n\n`;

        // A very long list would bury the useful part; show the head of it.
        const body = pretty.length > 4000 ? pretty.slice(0, 4000) + '\n…' : pretty;
        out.innerHTML = head + escapeHtml(body);
      } catch (err) {
        out.innerHTML = `<span class="bad">Request failed:</span> ${escapeHtml(String(err && err.message))}`;
      } finally {
        btn.disabled = false;
      }
    });
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : s;
    return d.innerHTML;
  }
})();
