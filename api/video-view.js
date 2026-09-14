/* POST /api/video-view — log one view of a video walkthrough.
 *
 * The browser can't see its own public IP, and a client-supplied one would be
 * trivially forgeable, so the IP is read here from the request headers. That's
 * the whole reason this is a serverless function rather than a direct insert
 * from the page.
 *
 * Body: { "token": "<share token>" }
 * Everything else — IP, user agent, referrer, geo — comes from the request.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

/* Vercel parses JSON bodies; a bare Node server doesn't. Handle both. */
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

/* The first entry in x-forwarded-for is the original client; everything after
   it is the proxy chain. Vercel also sets x-real-ip, which is already just the
   client. */
function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const first = String(forwarded).split(',')[0].trim();
    if (first) return first;
  }
  return (
    req.headers['x-real-ip'] ||
    (req.socket && req.socket.remoteAddress) ||
    null
  );
}

function rest(path, options) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...(options && options.headers),
    },
  });
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({
      error: 'Supabase not configured',
      detail: 'Set SUPABASE_URL and SUPABASE_ANON_KEY in the environment.',
    });
  }

  const body = await readBody(req);
  const token = String(body.token || '').trim();
  if (!token) return res.status(400).json({ error: 'Missing token' });

  try {
    // Look the video up by token rather than trusting an id from the client —
    // otherwise anyone could inflate the count on any row they can name.
    const lookup = await rest(
      `video_walkthroughs?select=id,token&token=eq.${encodeURIComponent(token)}`
    );

    if (!lookup.ok) {
      const detail = await lookup.text();
      return res.status(500).json({
        error: 'Lookup failed',
        detail: /video_walkthroughs/.test(detail)
          ? 'Run supabase/migrations/008-video-analytics.sql in the Supabase SQL editor.'
          : detail.slice(0, 200),
      });
    }

    const rows = await lookup.json();
    const video = Array.isArray(rows) ? rows[0] : null;
    if (!video) return res.status(404).json({ error: 'No video with that token' });

    // Vercel's geo headers; absent locally and on other hosts, which is fine —
    // the columns are nullable.
    const geo = {
      city: req.headers['x-vercel-ip-city']
        ? decodeURIComponent(req.headers['x-vercel-ip-city'])
        : null,
      region: req.headers['x-vercel-ip-country-region'] || null,
      country: req.headers['x-vercel-ip-country'] || null,
    };

    const insert = await rest('video_walkthrough_views', {
      method: 'POST',
      body: JSON.stringify({
        video_id: video.id,
        token: video.token,
        ip_address: clientIp(req),
        user_agent: req.headers['user-agent'] || null,
        referrer: body.referrer || req.headers.referer || null,
        ...geo,
      }),
    });

    if (!insert.ok) {
      const detail = await insert.text();
      return res.status(500).json({ error: 'Could not log view', detail: detail.slice(0, 200) });
    }

    // Keep the denormalized total in step. Best-effort: the log row is the
    // record that matters, so a failed bump must not fail the request.
    await rest('rpc/increment_video_view', {
      method: 'POST',
      body: JSON.stringify({ p_video_id: video.id }),
    }).catch(() => {});

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'Unexpected error', detail: String(err && err.message) });
  }
};
