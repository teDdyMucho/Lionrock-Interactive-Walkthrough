/* GET /api/walkthroughs — every published walkthrough, with its shareable link.
 *
 * Secured with an API key generated from /manage/api/. Send it as either:
 *   Authorization: Bearer <key>
 *   x-api-key: <key>
 *
 * The api_keys table is the ONLY source of truth. A key works if a matching row
 * exists, isn't revoked, and hasn't expired — nothing else is accepted, so
 * revoking a row kills that key immediately.
 *
 * Runs server-side, so it can use the service-role key if one is configured.
 * It falls back to the anon key, which is enough because reads are public.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

/* Query-string params. `req.query` exists on Vercel but not on a bare Node
   server, so parse the URL instead — the same code then works in both. */
function query(req) {
  const i = (req.url || '').indexOf('?');
  if (i === -1) return {};
  const out = {};
  new URLSearchParams(req.url.slice(i + 1)).forEach((v, k) => { out[k] = v; });
  return out;
}

/* "false"/"0"/"no" are false; anything else present is true. A bare `?flag`
   (no value) reads as true, which is what a caller expects. */
function truthy(v) {
  if (v === '' || v === undefined || v === null) return true;
  return !['false', '0', 'no', 'off'].includes(String(v).toLowerCase());
}

/* The database is the only source of truth: a key is valid only if a matching
 * row exists in api_keys, isn't revoked, and hasn't expired. Revoking a row in
 * the table therefore kills the key immediately — there is no env-var bypass.
 *
 * Keys are matched by SHA-256 hash. The plaintext is never stored, so a leaked
 * database still can't be used to call the API. */
async function authorize(presented) {
  const hash = require('crypto').createHash('sha256').update(presented).digest('hex');

  let rows;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/api_keys?select=id,name,expires_at,revoked_at&key_hash=eq.${hash}`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );

    if (!r.ok) {
      const detail = await r.text();
      // A missing table is a deployment mistake, not a caller mistake — say so
      // rather than returning a misleading 401.
      return {
        ok: false,
        status: 500,
        body: {
          error: 'Key store unavailable',
          detail: /api_keys/.test(detail)
            ? 'Run supabase/migrations/007-api-keys.sql, then generate a key at /manage/api/.'
            : detail.slice(0, 200),
        },
      };
    }
    rows = await r.json();
  } catch (err) {
    return {
      ok: false,
      status: 500,
      body: { error: 'Key store unreachable', detail: String(err && err.message) },
    };
  }

  const record = Array.isArray(rows) ? rows[0] : null;

  // Not in the database at all — not a valid key, whatever it is.
  if (!record) {
    return { ok: false, status: 401, body: { error: 'Unauthorized', detail: 'Unknown API key.' } };
  }

  if (record.revoked_at) {
    return { ok: false, status: 401, body: { error: 'Unauthorized', detail: 'This key was revoked.' } };
  }

  if (record.expires_at && new Date(record.expires_at) <= new Date()) {
    return {
      ok: false,
      status: 401,
      body: { error: 'Unauthorized', detail: `This key expired on ${record.expires_at}.` },
    };
  }

  // Best-effort usage stamp — never let it block or fail the response.
  fetch(`${SUPABASE_URL}/rest/v1/api_keys?id=eq.${record.id}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ last_used_at: new Date().toISOString() }),
  }).catch(() => {});

  return { ok: true, name: record.name };
}

function presentedKey(req) {
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const header = req.headers['x-api-key'];
  return typeof header === 'string' ? header.trim() : '';
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({
      error: 'Supabase not configured',
      detail: 'Set SUPABASE_URL and SUPABASE_ANON_KEY in the environment.',
    });
  }

  const presented = presentedKey(req);
  if (!presented) {
    return res.status(401).json({ error: 'Unauthorized', detail: 'No API key provided.' });
  }

  const auth = await authorize(presented);
  if (!auth.ok) {
    // Fail closed: a missing env key must never mean "no security".
    if (auth.status === 500) return res.status(500).json(auth.body);
    return res.status(401).json(auth.body);
  }

  try {
    const select =
      'slug,title,address,mode,created_at,' +
      'property_videos(area,label,video_url,sort_order)';

    const upstream = await fetch(
      `${SUPABASE_URL}/rest/v1/properties?select=${encodeURIComponent(select)}&order=created_at`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );

    if (!upstream.ok) {
      const detail = await upstream.text();
      return res.status(502).json({ error: 'Upstream query failed', detail: detail.slice(0, 300) });
    }

    const rows = await upstream.json();

    // The site's own origin, so links are usable wherever this is deployed
    // rather than hardcoded to one domain.
    const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const origin = `${proto}://${host}`;

    const walkthroughs = (rows || [])
      .map((p) => {
        const clips = (p.property_videos || []).filter((v) => v.video_url);
        const intro = clips.find((v) => v.area === 'intro');
        const rooms = clips
          .filter((v) => v.area !== 'intro')
          .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

        // A property with no playable clip isn't shown in the gallery either.
        if (!rooms.length) return null;

        const mode = p.mode === 'video' ? 'video' : 'interactive';
        const path = `${mode === 'video' ? '/video/' : '/walkthrough/'}?property=${encodeURIComponent(p.slug)}`;

        return {
          title: p.title,
          address: p.address || null,
          slug: p.slug,
          type: mode,                       // which tab it belongs to
          url: `${origin}${path}`,          // the shareable link
          path,
          hasIntro: !!intro,
          roomCount: rooms.length,
          rooms: rooms.map((r) => ({
            label: r.label,
            area: r.area,
            video: r.video_url,
          })),
          createdAt: p.created_at,
        };
      })
      .filter(Boolean);

    /* ---- filters ----
     *
     * Applied after building the list so every filter sees the same shape the
     * caller gets back. All are optional; combining them narrows further.
     *
     *   ?slug=unit-9          exactly one property
     *   ?type=video           only that tab
     *   ?search=chicago       title/address/slug contains this (case-insensitive)
     *   ?hasIntro=true        only properties with an intro clip
     *   ?includeRooms=false   omit the rooms array (smaller payload)
     *   ?limit=10&offset=20   paging
     */
    const q = query(req);

    let results = walkthroughs;
    const applied = {};

    if (q.slug) {
      applied.slug = q.slug;
      results = results.filter((w) => w.slug === q.slug);
    }

    if (q.type) {
      const wanted = String(q.type).toLowerCase();
      if (wanted !== 'video' && wanted !== 'interactive') {
        return res.status(400).json({
          error: 'Invalid type',
          detail: 'type must be "video" or "interactive".',
        });
      }
      applied.type = wanted;
      results = results.filter((w) => w.type === wanted);
    }

    if (q.search) {
      const needle = String(q.search).toLowerCase();
      applied.search = q.search;
      results = results.filter((w) =>
        [w.title, w.address, w.slug]
          .filter(Boolean)
          .some((field) => field.toLowerCase().includes(needle))
      );
    }

    if (q.hasIntro !== undefined) {
      const wanted = truthy(q.hasIntro);
      applied.hasIntro = wanted;
      results = results.filter((w) => w.hasIntro === wanted);
    }

    // Total before paging, so a caller can tell how many more there are.
    const matched = results.length;

    const offset = Math.max(0, parseInt(q.offset, 10) || 0);
    const limit = q.limit !== undefined ? Math.max(0, parseInt(q.limit, 10) || 0) : null;
    if (offset) applied.offset = offset;
    if (limit !== null) applied.limit = limit;

    if (offset) results = results.slice(offset);
    if (limit !== null) results = results.slice(0, limit);

    // Rooms are the bulk of the payload; a caller that only wants links can drop
    // them. roomCount stays either way.
    if (q.includeRooms !== undefined && !truthy(q.includeRooms)) {
      applied.includeRooms = false;
      results = results.map(({ rooms, ...rest }) => rest);
    }

    // Asking for one specific property that doesn't exist is a 404, not an
    // empty list — it means the slug is wrong, which is worth saying plainly.
    if (q.slug && !matched) {
      return res.status(404).json({
        error: 'No walkthrough with that slug',
        detail: `Nothing published at slug "${q.slug}".`,
        slug: q.slug,
      });
    }

    return res.status(200).json({
      count: results.length,
      matched,                                  // before limit/offset
      total: walkthroughs.length,               // before any filter
      filters: Object.keys(applied).length ? applied : null,
      generatedAt: new Date().toISOString(),
      walkthroughs: results,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Unexpected error', detail: String(err && err.message) });
  }
};
