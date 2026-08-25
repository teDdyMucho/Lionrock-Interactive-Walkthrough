/* /api/keys — mint, list, and revoke API keys.
 *
 *   GET    /api/keys           list keys (never the plaintext)
 *   POST   /api/keys           create one   { name, expires: '1w'|'1m'|'1y'|'never' }
 *   DELETE /api/keys?id=<uuid> revoke one
 *
 * Protected by the ADMIN's Supabase session, not by an API key — minting keys
 * must not be possible with a key, or a leaked one could mint replacements for
 * itself and survive revocation.
 *
 * Only a SHA-256 hash is stored. The plaintext is returned exactly once, in the
 * POST response, and cannot be recovered afterwards.
 */

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

const EXPIRY_OPTIONS = {
  '1w': { label: '1 week', days: 7 },
  '1m': { label: '1 month', days: 30 },
  '1y': { label: '1 year', days: 365 },
  never: { label: 'Never expires', days: null },
};

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function bearer(req) {
  const auth = req.headers.authorization || '';
  return auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
}

/* Confirms the caller is a signed-in admin by asking Supabase who the token
   belongs to. Never trusts anything the browser claims about itself. */
async function currentAdmin(req) {
  const token = bearer(req);
  if (!token) return null;

  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const user = await r.json();
    return user && user.email ? user : null;
  } catch {
    return null;
  }
}

function db(path, options = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
}

function query(req) {
  const i = (req.url || '').indexOf('?');
  if (i === -1) return {};
  const out = {};
  new URLSearchParams(req.url.slice(i + 1)).forEach((v, k) => { out[k] = v; });
  return out;
}

function readBody(req) {
  return new Promise((resolve) => {
    if (req.body) {                       // Vercel may have parsed it already
      resolve(typeof req.body === 'string' ? safeParse(req.body) : req.body);
      return;
    }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => resolve(safeParse(raw)));
    req.on('error', () => resolve({}));
  });
}

function safeParse(s) {
  try { return JSON.parse(s || '{}'); } catch { return {}; }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({
      error: 'Supabase not configured',
      detail: 'Set SUPABASE_URL and SUPABASE_ANON_KEY in the environment.',
    });
  }

  const admin = await currentAdmin(req);
  if (!admin) {
    return res.status(401).json({
      error: 'Unauthorized',
      detail: 'Sign in as an admin. This endpoint does not accept API keys.',
    });
  }

  // ---- list ----
  if (req.method === 'GET') {
    const r = await db('api_keys?select=id,name,key_prefix,expires_at,created_at,created_by,last_used_at,revoked_at&order=created_at.desc');
    if (!r.ok) {
      const detail = await r.text();
      return res.status(502).json({
        error: 'Could not list keys',
        detail: /api_keys/.test(detail)
          ? 'Run supabase/migrations/007-api-keys.sql first.'
          : detail.slice(0, 300),
      });
    }
    const rows = await r.json();
    const now = Date.now();

    return res.status(200).json({
      count: rows.length,
      keys: rows.map((k) => ({
        ...k,
        status: k.revoked_at
          ? 'revoked'
          : k.expires_at && new Date(k.expires_at).getTime() <= now
            ? 'expired'
            : 'active',
      })),
    });
  }

  // ---- create ----
  if (req.method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    const expires = String(body.expires || 'never');

    if (!name) {
      return res.status(400).json({ error: 'Name required', detail: 'Say what this key is for.' });
    }
    if (!EXPIRY_OPTIONS[expires]) {
      return res.status(400).json({
        error: 'Invalid expiry',
        detail: `expires must be one of: ${Object.keys(EXPIRY_OPTIONS).join(', ')}.`,
      });
    }

    const key = crypto.randomBytes(32).toString('hex');
    const { days } = EXPIRY_OPTIONS[expires];
    const expiresAt = days === null
      ? null
      : new Date(Date.now() + days * 86400000).toISOString();

    const r = await db('api_keys', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        name,
        key_hash: sha256(key),
        key_prefix: key.slice(0, 8),
        expires_at: expiresAt,
        created_by: admin.email,
      }),
    });

    if (!r.ok) {
      const detail = await r.text();
      return res.status(502).json({
        error: 'Could not create the key',
        detail: /api_keys/.test(detail)
          ? 'Run supabase/migrations/007-api-keys.sql first.'
          : detail.slice(0, 300),
      });
    }

    const [row] = await r.json();

    return res.status(201).json({
      // Shown once. There is no way to retrieve it later — only the hash is kept.
      key,
      warning: 'Copy this now. It cannot be shown again.',
      id: row.id,
      name: row.name,
      keyPrefix: row.key_prefix,
      expiresAt: row.expires_at,
      expiresLabel: EXPIRY_OPTIONS[expires].label,
      createdAt: row.created_at,
    });
  }

  // ---- revoke ----
  if (req.method === 'DELETE') {
    const { id } = query(req);
    if (!id) return res.status(400).json({ error: 'Missing id' });

    // Revoked, not deleted, so the record of what existed survives.
    const r = await db(`api_keys?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ revoked_at: new Date().toISOString() }),
    });

    if (!r.ok) {
      return res.status(502).json({ error: 'Could not revoke', detail: (await r.text()).slice(0, 300) });
    }
    const rows = await r.json();
    if (!rows.length) return res.status(404).json({ error: 'No key with that id' });

    return res.status(200).json({ revoked: true, id, name: rows[0].name });
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
};
