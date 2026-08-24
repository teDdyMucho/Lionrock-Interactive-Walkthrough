/* Runs GET /api/walkthroughs locally, without deploying.
 *
 *   npm run test:api
 *
 * Starts the serverless handler on a local port, exercises the auth paths, and
 * prints the walkthrough list. Reads .env for the keys.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 5099;

// Load .env the way Vercel loads its environment variables.
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2];
  });
}

const KEY = process.env.WALKTHROUGH_API_KEY;
if (!KEY) {
  console.error('\n✗ WALKTHROUGH_API_KEY is not set in .env.\n');
  process.exit(1);
}

const handler = require(path.join(ROOT, 'api', 'walkthroughs.js'));

// Minimal shim for the Response helpers Vercel provides.
const server = http.createServer(async (req, res) => {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(o, null, 2));
  };
  await handler(req, res);
});

const call = (headers, method = 'GET') =>
  new Promise((resolve) => {
    const req = http.request(
      { host: 'localhost', port: PORT, path: '/api/walkthroughs', method, headers },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end();
  });

const check = (label, got, want) =>
  console.log(`  ${got === want ? 'PASS' : `FAIL (got ${got}, want ${want})`}  ${label}`);

server.listen(PORT, async () => {
  console.log(`\nTesting the API on http://localhost:${PORT}/api/walkthroughs\n`);

  console.log('Security:');
  check('no key is rejected',        (await call({})).status, 401);
  check('wrong key is rejected',     (await call({ Authorization: 'Bearer wrong' })).status, 401);
  check('non-GET is rejected',       (await call({ 'x-api-key': KEY }, 'POST')).status, 405);
  check('Bearer header works',       (await call({ Authorization: `Bearer ${KEY}` })).status, 200);
  check('x-api-key header works',    (await call({ 'x-api-key': KEY })).status, 200);

  const res = await call({ 'x-api-key': KEY });
  let data;
  try {
    data = JSON.parse(res.body);
  } catch {
    console.error('\n✗ Response was not JSON:\n', res.body.slice(0, 400));
    server.close();
    process.exit(1);
  }

  if (data.error) {
    console.error(`\n✗ ${data.error}${data.detail ? ` — ${data.detail}` : ''}\n`);
    server.close();
    process.exit(1);
  }

  console.log(`\nWalkthroughs (${data.count}):\n`);
  data.walkthroughs.forEach((w) => {
    console.log(`  ${w.type.padEnd(11)} ${String(w.roomCount).padStart(2)} rooms  ` +
                `intro:${w.hasIntro ? 'y' : 'n'}  ${w.title}`);
    console.log(`              ${w.path}`);
  });

  console.log('\nFull JSON for the first entry:\n');
  console.log(JSON.stringify(data.walkthroughs[0], null, 2).split('\n').slice(0, 22).join('\n'));
  console.log('  …\n');

  server.close();
});
