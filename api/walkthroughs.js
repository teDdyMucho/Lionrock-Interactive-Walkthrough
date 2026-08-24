/* GET /api/walkthroughs — every published walkthrough, with its shareable link.
 *
 * Secured with a shared API key. Send it as either:
 *   Authorization: Bearer <WALKTHROUGH_API_KEY>
 *   x-api-key: <WALKTHROUGH_API_KEY>
 *
 * Set WALKTHROUGH_API_KEY in Vercel → Project Settings → Environment Variables.
 * Without it set, the endpoint refuses every request rather than defaulting to
 * open — a missing secret must never mean "no security".
 *
 * Runs server-side, so it can use the service-role key if one is configured.
 * It falls back to the anon key, which is enough because reads are public.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const API_KEY = process.env.WALKTHROUGH_API_KEY;

/* Constant-time compare so a wrong key can't be guessed byte-by-byte from
   response timing. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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

  if (!API_KEY) {
    // Fail closed: never serve data because a secret wasn't configured.
    return res.status(500).json({
      error: 'API key not configured',
      detail: 'Set WALKTHROUGH_API_KEY in the deployment environment.',
    });
  }

  if (!safeEqual(presentedKey(req), API_KEY)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({
      error: 'Supabase not configured',
      detail: 'Set SUPABASE_URL and SUPABASE_ANON_KEY in the environment.',
    });
  }

  try {
    const select =
      'slug,title,address,mode,created_at,' +
      'property_videos(area,label,video_url,reverse_url,sort_order)';

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
            reverse: r.reverse_url || null, // pre-rendered backwards clip
          })),
          createdAt: p.created_at,
        };
      })
      .filter(Boolean);

    return res.status(200).json({
      count: walkthroughs.length,
      generatedAt: new Date().toISOString(),
      walkthroughs,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Unexpected error', detail: String(err && err.message) });
  }
};
