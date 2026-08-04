/* Persistent video cache.
 *
 * By default the walkthrough downloads each clip into an in-memory Blob, which
 * is thrown away on reload — so every visit re-downloads ~40MB.
 *
 * This stores the clips in Cache Storage instead, which survives reloads and
 * works offline. It's invisible browser storage, not the device's Downloads
 * folder: nothing appears in a file manager, and the user can clear it from
 * their browser settings (or the Clear button in the prompt).
 *
 * Everything here degrades safely — if Cache Storage is unavailable or a quota
 * error hits, the caller just falls back to a normal network fetch.
 */

const CACHE_NAME = 'lionrock-walkthrough-v1';

/* Safari in private mode exposes caches but throws on use, so feature-detection
   alone isn't enough — callers treat a rejection as "no cache". */
function cacheAvailable() {
  return typeof caches !== 'undefined' && !!window.isSecureContext;
}

async function openCache() {
  if (!cacheAvailable()) return null;
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

/* True when every url is already stored, i.e. this property is fully offline. */
async function isCached(urls) {
  const cache = await openCache();
  if (!cache) return false;
  for (const url of urls) {
    if (!(await cache.match(url))) return false;
  }
  return true;
}

/* How many bytes of this property are already stored. */
async function cachedBytes(urls) {
  const cache = await openCache();
  if (!cache) return 0;

  let total = 0;
  for (const url of urls) {
    const hit = await cache.match(url);
    if (!hit) continue;
    try {
      total += (await hit.clone().blob()).size;
    } catch { /* unreadable entry — ignore */ }
  }
  return total;
}

/* Downloads every url into the cache, reporting 0..1 overall progress.
   Resolves to the number of clips successfully stored. */
async function downloadToCache(urls, onProgress) {
  const cache = await openCache();
  if (!cache) throw new Error('This browser can\'t store the walkthrough offline.');

  const progress = urls.map(() => 0);
  const report = () => {
    if (!onProgress) return;
    onProgress(progress.reduce((a, b) => a + b, 0) / urls.length);
  };

  let stored = 0;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];

    if (await cache.match(url)) {       // already have it
      progress[i] = 1;
      stored++;
      report();
      continue;
    }

    const response = await fetch(url);
    if (!response.ok || !response.body) {
      progress[i] = 1;
      report();
      continue;
    }

    const total = Number(response.headers.get('Content-Length')) || 0;
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (total) {
        progress[i] = Math.min(1, received / total);
        report();
      }
    }

    const blob = new Blob(chunks, {
      type: response.headers.get('Content-Type') || 'video/mp4',
    });

    try {
      // Rebuild a Response — the original body is already consumed.
      await cache.put(url, new Response(blob));
      stored++;
    } catch (err) {
      // Quota exceeded is the realistic failure. Surface it rather than
      // silently pretending the clip is saved.
      throw new Error(
        /quota/i.test(String(err && err.name) + String(err && err.message))
          ? 'Not enough storage space on this device to save the walkthrough.'
          : 'Couldn\'t save the walkthrough to this device.'
      );
    }

    progress[i] = 1;
    report();
  }

  return stored;
}

/* Returns a blob: URL for a cached clip, or null if it isn't stored. Used by
   the loader so a cached property never touches the network. */
async function blobUrlFromCache(url) {
  const cache = await openCache();
  if (!cache) return null;
  const hit = await cache.match(url);
  if (!hit) return null;
  try {
    return URL.createObjectURL(await hit.blob());
  } catch {
    return null;
  }
}

async function clearCache() {
  if (typeof caches === 'undefined') return;
  try {
    await caches.delete(CACHE_NAME);
  } catch { /* nothing to do */ }
}

/* Asks the browser not to evict this data under storage pressure. Best-effort:
   Chrome may grant silently, Safari ignores it. */
async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      return await navigator.storage.persist();
    }
  } catch { /* ignore */ }
  return false;
}

window.VideoCache = {
  available: cacheAvailable,
  isCached,
  cachedBytes,
  downloadToCache,
  blobUrlFromCache,
  clearCache,
  requestPersistence,
};
