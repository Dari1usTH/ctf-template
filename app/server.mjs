import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { AppError, exists, safePath, scan } from './core.mjs';
import { Workspace } from './workspace.mjs';

process.umask(0o022);
export async function createApplication(options = {}) {
  const root = path.resolve(options.root || process.env.CTF_WORKSPACE || process.cwd());
  const workspace = new Workspace(root, { timezone: options.timezone || process.env.TZ || 'Europe/Bucharest' });
  await workspace.init();
  let token = options.token || process.env.CTF_ACCESS_TOKEN;
  const tokenFile = path.join(workspace.state, 'access-token');
  if (!token) {
    if (!await exists(tokenFile)) await fs.writeFile(tokenFile, crypto.randomBytes(24).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
    token = (await fs.readFile(await safePath(workspace.state, 'access-token'), 'utf8')).trim();
  }
  if (token.length < 16) throw new Error('CTF_ACCESS_TOKEN must be at least 16 characters.');
  const sessions = new Map(), attempts = new Map();
  const publicDir = path.join(import.meta.dirname, 'public');
  const secureEqual = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest());
  const send = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  };
  async function body(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 4 * 1024 * 1024) throw new AppError('Request too large.', 413); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new AppError('Invalid JSON.'); }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      const route = url.pathname;
      if (req.method === 'GET' && route === '/api/health') return send(res, 200, { ok: true });
      if (!route.startsWith('/api/')) {
        if (req.method !== 'GET') throw new AppError('Method not allowed.', 405);
        const asset = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]]).get(route);
        if (!asset) throw new AppError('Page not found.', 404);
        const content = await fs.readFile(path.join(publicDir, asset[0]));
        res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8` }); return res.end(content);
      }
      if (!['GET', 'POST'].includes(req.method)) throw new AppError('Method not allowed.', 405);
      if (req.method === 'POST') {
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) throw new AppError('Origin not allowed.', 403);
        if (req.headers['x-ctf-request'] !== '1' || !req.headers['content-type']?.startsWith('application/json')) throw new AppError('Invalid request headers.', 403);
      }
      if (req.method === 'POST' && route === '/api/login') {
        const ip = req.socket.remoteAddress;
        const now = Date.now();
        for (const [key, value] of attempts) if (value.until < now) attempts.delete(key);
        const rate = attempts.get(ip) || { count: 0, until: now + 60000 };
        if (++rate.count > 10) throw new AppError('Too many attempts. Retry in one minute.', 429);
        attempts.set(ip, rate);
        const input = await body(req);
        if (typeof input.token !== 'string' || !secureEqual(input.token, token)) throw new AppError('Incorrect token.', 401);
        const session = crypto.randomBytes(32).toString('hex');
        for (const [key, value] of sessions) if (value < now) sessions.delete(key);
        sessions.set(session, now + 12 * 3600000);
        res.setHeader('Set-Cookie', `ctf_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
        return send(res, 200, { ok: true });
      }
      const session = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('ctf_session='))?.slice(12);
      if (!session || !sessions.has(session) || sessions.get(session) < Date.now()) throw new AppError('Sign in required.', 401);
      if (req.method === 'POST' && route === '/api/logout') {
        sessions.delete(session); res.setHeader('Set-Cookie', 'ctf_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && route === '/api/session') return send(res, 200, { ok: true, busy: workspace.busy, timezone: workspace.timezone });
      if (req.method === 'GET' && route === '/api/challenges') return send(res, 200, await scan(root));
      if (req.method === 'POST' && route === '/api/preview') return send(res, 200, await workspace.preview(await body(req)));
      if (req.method === 'POST' && route === '/api/pack') return send(res, 201, await workspace.pack((await body(req)).token));
      if (req.method === 'GET' && route === '/api/batches') return send(res, 200, await workspace.batches());
      if (req.method === 'GET' && route === '/api/inspect') return send(res, 200, await workspace.inspect(url.searchParams.get('path')));
      if (req.method === 'GET' && route === '/api/history') return send(res, 200, (await workspace.operations()).filter(op => op.type !== 'undo'));
      if (req.method === 'GET' && route === '/api/logs') return send(res, 200, await workspace.logs());
      if (req.method === 'POST' && route === '/api/delete') return send(res, 200, await workspace.remove((await body(req)).path));
      if (req.method === 'POST' && route === '/api/undo') return send(res, 200, await workspace.undo((await body(req)).id));
      if (req.method === 'GET' && route === '/api/download') {
        const relative = url.searchParams.get('path');
        if (typeof relative !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:_|\/)/.test(relative)) throw new AppError('Invalid path.');
        await safePath(root, 'Challenges');
        const target = await safePath(workspace.output, relative);
        const handle = await fs.open(target, 'r');
        if (!(await handle.stat()).isFile()) { await handle.close(); throw new AppError('Select a file.'); }
        res.writeHead(200, { 'Content-Type': target.endsWith('.tar') ? 'application/x-tar' : 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(target)).replaceAll("'", '%27')}` });
        await pipeline(handle.createReadStream(), res); return;
      }
      throw new AppError('Endpoint not found.', 404);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const status = error.status || (error.code === 'ENOENT' ? 404 : 500);
      if (status >= 500) { console.error(error); await workspace.log({ type: 'error', message: error.message }).catch(() => {}); }
      send(res, status, { error: status === 404 ? 'File or resource not found.' : (error.status ? error.message : 'Internal error. Check docker compose logs.') });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return { server, workspace };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { server } = await createApplication();
  const port = Number(process.env.PORT || 8080);
  server.listen(port, '0.0.0.0', () => console.log(`CTF Author: http://0.0.0.0:${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 10000).unref(); });
}
