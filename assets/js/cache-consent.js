/* Storage consent, asked once on the gallery (the welcome page).
 *
 * The answer is a single site-wide preference, not per-property: once the
 * viewer allows it, opening any project caches its videos automatically with no
 * further prompting. Declining means walkthroughs just stream as before.
 *
 * Stored in localStorage under CONSENT_KEY as 'allow' | 'decline'.
 */

const CONSENT_KEY = 'lionrock-cache-consent';

function getCacheConsent() {
  try {
    return localStorage.getItem(CONSENT_KEY); // 'allow' | 'decline' | null
  } catch {
    return null; // storage blocked (private mode) — treat as unanswered
  }
}

function setCacheConsent(value) {
  try {
    localStorage.setItem(CONSENT_KEY, value);
  } catch { /* nothing we can do; the session just won't remember */ }
}

/* Shows the prompt only when there's an unanswered question worth asking:
   storage has to be usable, and they mustn't have answered already. */
function maybeAskForCacheConsent() {
  const panel = document.getElementById('cache-consent');
  if (!panel) return;

  // Cache Storage needs a secure context — on plain http there is nothing to
  // consent to, so asking would be noise.
  const usable =
    typeof caches !== 'undefined' && window.isSecureContext;

  if (!usable || getCacheConsent()) return;

  panel.classList.add('show');

  const close = (answer) => {
    setCacheConsent(answer);
    panel.classList.remove('show');
  };

  document.getElementById('cache-allow')
    .addEventListener('click', async () => {
      close('allow');
      // Ask the browser to keep the data under storage pressure. Best-effort:
      // Chrome may grant silently, Safari ignores it.
      try {
        if (navigator.storage && navigator.storage.persist) {
          await navigator.storage.persist();
        }
      } catch { /* ignore */ }
    }, { once: true });

  document.getElementById('cache-decline')
    .addEventListener('click', () => close('decline'), { once: true });
}

window.CacheConsent = { get: getCacheConsent, set: setCacheConsent };

document.addEventListener('DOMContentLoaded', maybeAskForCacheConsent);
