/* Local dev server: static files + the /api/ serverless functions.
 *
 *   npm run dev
 *
 * `npx serve` only serves files, so /api/walkthroughs 404s under it — the
 * handler in api/ never runs. Vercel routes those itself in production; this
 * does the same locally so the API and the "Try it" button work while
 * developing.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 5000;

// Load .env the way Vercel loads its environment variables.
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  });
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.woff2': 'font/woff2',
};

/* Minimal shims for the helpers Vercel's runtime adds to `res`. */
function decorate(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => {
    if (!res.headersSent) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj, null, 2));
  };
  res.send = (body) => res.end(body);
  return res;
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  const pathname = decodeURIComponent(url);

  // ---- API routes: api/<name>.js -> /api/<name> ----
  if (pathname.startsWith('/api/')) {
    const name = pathname.slice('/api/'.length).replace(/\/+$/, '');
    const file = path.join(ROOT, 'api', `${name}.js`);

    if (!fs.existsSync(file)) {
      decorate(res).status(404).json({ error: `No API route for ${pathname}` });
      return;
    }

    try {
      // Re-require each time so edits are picked up without a restart.
      delete require.cache[require.resolve(file)];
      const handler = require(file);
      await handler(req, decorate(res));
    } catch (err) {
      console.error(`API ${pathname} threw:`, err);
      if (!res.headersSent) {
        decorate(res).status(500).json({ error: 'Handler threw', detail: String(err && err.message) });
      }
    }
    return;
  }

  // ---- static files ----
  let filePath = path.join(ROOT, pathname);
  if (pathname.endsWith('/')) filePath = path.join(filePath, 'index.html');

  fs.stat(filePath, (err, stat) => {
    // A directory without a trailing slash: serve its index.html.
    if (!err && stat.isDirectory()) filePath = path.join(filePath, 'index.html');

    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Content-Length': data.length,
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  });
});

server.listen(PORT, () => {
  console.log(`\n  Lion Rock dev server`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  → http://localhost:${PORT}/api/walkthroughs  (API routes enabled)\n`);
});
