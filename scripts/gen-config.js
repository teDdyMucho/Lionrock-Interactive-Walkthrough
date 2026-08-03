/* Generate assets/js/supabase-config.js from .env (or from real environment
 * variables, which is what Netlify provides at deploy time).
 *
 *   node scripts/gen-config.js
 *
 * This site has no bundler, so the browser can't read .env itself — it loads
 * supabase-config.js via a <script> tag. This script bridges the two so the
 * values only ever get typed once, in .env.
 *
 * Both .env and the generated file are gitignored.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env');
const outPath = path.join(root, 'assets', 'js', 'supabase-config.js');

/* Minimal .env parser: KEY=VALUE, ignoring blanks and # comments.
   Values are used literally, so an unquoted key with '=' in it still works. */
function parseEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;

  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    // strip surrounding quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const env = parseEnv(envPath);

// Real environment variables win over .env — that's how Netlify injects them.
const url = process.env.SUPABASE_URL || env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY;
const bucket = process.env.SUPABASE_BUCKET || env.SUPABASE_BUCKET || 'walkthrough-videos';

const missing = [];
if (!url) missing.push('SUPABASE_URL');
if (!anonKey) missing.push('SUPABASE_ANON_KEY');

if (missing.length) {
  console.error(`\n✗ Missing ${missing.join(' and ')}.`);
  console.error(`  Add them to .env (copy .env.example if you haven't yet).\n`);
  process.exit(1);
}

if (url.includes('YOUR-PROJECT-REF') || anonKey.includes('YOUR-ANON')) {
  console.error('\n✗ .env still has the placeholder values — paste your real');
  console.error('  Project URL and anon key from Supabase → Settings → API.\n');
  process.exit(1);
}

// Guard against the one mistake that actually matters: the service_role key
// bypasses RLS entirely and must never be served to a browser.
try {
  const payload = JSON.parse(
    Buffer.from(anonKey.split('.')[1], 'base64').toString('utf8')
  );
  if (payload.role && payload.role !== 'anon') {
    console.error(`\n✗ That key has role "${payload.role}", not "anon".`);
    console.error('  Never put the service_role key in client code — it bypasses');
    console.error('  Row Level Security. Use the anon / public key instead.\n');
    process.exit(1);
  }
} catch {
  // Not a decodable JWT — let it through; Supabase will reject it if it's wrong.
}

const banner =
  '// GENERATED FILE — do not edit, and do not commit.\n' +
  '// Regenerate with:  npm run config\n' +
  '// Source of truth is .env (both files are gitignored).\n';

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(
  outPath,
  `${banner}window.SUPABASE_CONFIG = ${JSON.stringify({ url, anonKey, bucket }, null, 2)};\n`
);

const host = url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
console.log(`\n✓ Wrote assets/js/supabase-config.js`);
console.log(`  project: ${host}`);
console.log(`  bucket:  ${bucket}\n`);
