import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MoneyEngine } from './monetary-engine.mjs';
import { AuthStore } from './auth-store.mjs';

const assetRoot = new URL('../public/', import.meta.url);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]
]);
const code = (message, status = 400) => Object.assign(Error(message), { status });
function only(body, keys) {
  if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).some(k => !keys.includes(k))) throw code('invalid_fields');
}
function requestId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,36}$/.test(value)) throw code('invalid_request_id'); return value;
}
async function jsonBody(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw code('json_required', 415);
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 16384) throw code('body_too_large', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw code('invalid_json'); }
}
function sessionToken(req) {
  const cookies = (req.headers.cookie ?? '').split(';').map(s => s.trim());
  return cookies.find(s => s.startsWith('agarmon_session='))?.slice('agarmon_session='.length);
}
function cookie(token, origin, remove = false) {
  return `agarmon_session=${remove ? '' : token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${remove ? 0 : 86400}${origin.startsWith('https:') ? '; Secure' : ''}`;
}

/** Web sandbox. Live funds are intentionally unsupported until gateway/identity integration exists. */
export function createWebApp({ dataDirectory, publicOrigin, mode = 'sandbox' } = {}) {
  if (mode !== 'sandbox') throw Error('live_mode_not_implemented');
  if (publicOrigin && (!['http:', 'https:'].includes(new URL(publicOrigin).protocol) || new URL(publicOrigin).origin !== publicOrigin)) throw Error('invalid_public_origin');
  if (!dataDirectory) throw Error('data_directory_required');
  mkdirSync(dataDirectory, { recursive: true });
  const money = new MoneyEngine({ databasePath: join(dataDirectory, 'money.sqlite'), countries: ['ZZ'] });
  const auth = new AuthStore(join(dataDirectory, 'auth.sqlite'));
  for (const mode of ['normal', 'hard']) for (const stake of [1000, 5000, 10000]) money.createMatch(`room_${mode}_${stake}`, mode, stake);
  const limit = new Map(); let authJobs = 0;
  const server = createServer(async (req, res) => {
    const origin = publicOrigin ?? `http://127.0.0.1:${server.address().port}`;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    try {
      const path = new URL(req.url, 'http://local').pathname;
      if (req.method === 'GET' && assets.has(path)) {
        const [file, type] = assets.get(path); res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
        res.end(readFileSync(new URL(file, assetRoot))); return;
      }
      if (!path.startsWith('/api/')) throw code('not_found', 404);
      const token = sessionToken(req), session = auth.session(token);
      if (req.method === 'GET' && path === '/api/state') {
        const s = money.snapshot(), user = session?.user;
        const rooms = Object.values(s.matches).map(m => ({
          id: m.id, mode: m.mode, entryCents: m.entryCents, phase: m.phase,
          players: Object.keys(m.players).length, joined: !!(user && m.players[user.id]?.status === 'queued'), durationMs: m.durationMs
        }));
        const name = user ? 'wallet:' + user.id : '';
        const history = user ? s.journal.filter(r => r.from === name || r.to === name).slice(-20).reverse().map(r => ({
          sequence: r.sequence, reason: r.reason, amountCents: r.to === name ? r.amount : -r.amount
        })) : [];
        const reservedCents = user ? Object.values(s.matches).reduce((sum, m) => sum + (s.accounts[`match:${m.id}:entry:${user.id}`] ?? 0), 0) : 0;
        const withdrawals = user ? Object.entries(s.withdrawals).filter(([,p]) => p.userId === user.id && ['reserved','unknown'].includes(p.status)).map(([id,p]) => ({ id, amountCents:p.amount, status:p.status })) : [];
        send({ sandbox: true, user: user ?? null, csrf: session?.csrf ?? null, balanceCents: s.accounts[name] ?? 0, reservedCents, rooms, history, withdrawals }); return;
      }
      if (req.method !== 'POST') throw code('not_found', 404);
      if (req.headers.origin !== origin) throw code('origin_denied', 403);
      const body = await jsonBody(req);
      if (['/api/register', '/api/login'].includes(path)) {
        only(body, path === '/api/register' ? ['email', 'password', 'name'] : ['email', 'password']);
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
        if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/u.test(email) || email.length > 254 ||
            typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 128) throw code('invalid_credentials_format');
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (path === '/api/register' && (name.length < 2 || name.length > 40)) throw code('invalid_name');
        const peer = req.socket.remoteAddress, now = Date.now();
        for (const [key, entry] of limit) if (entry.until <= now) limit.delete(key);
        const entry = limit.get(peer) ?? { count: 0, until: now + 600000 };
        if (++entry.count > 20 || authJobs >= 4 || limit.size > 5000) throw code('too_many_attempts', 429);
        limit.set(peer, entry); authJobs++;
        let user;
        try { user = path === '/api/register' ? await auth.register(email, body.password, name) : await auth.login(email, body.password); }
        finally { authJobs--; }
        // Synthetic identities exist only in this explicitly simulated sandbox, never a live KYC flow.
        money.registerUser({ id: user.id, identityVerified: true, adultVerified: true, residenceCountry: 'ZZ', locationCountry: 'ZZ' });
        const issued = auth.issue(user.id, token); res.setHeader('Set-Cookie', cookie(issued.token, origin));
        send({ user, csrf: issued.csrf, sandbox: true }, path === '/api/register' ? 201 : 200); return;
      }
      if (!session) throw code('authentication_required', 401);
      if (req.headers['x-csrf-token'] !== session.csrf) throw code('csrf_denied', 403);
      const userId = session.user.id;
      if (path === '/api/logout') {
        only(body, []); auth.revoke(token); res.setHeader('Set-Cookie', cookie('', origin, true)); send({ loggedOut: true }); return;
      }
      if (path === '/api/demo/funds') {
        only(body, ['amountCents', 'requestId']); const key = requestId(body.requestId);
        if (![1000, 5000, 10000].includes(body.amountCents)) throw code('invalid_amount');
        const s = money.snapshot(), paymentId = `deposit_${userId}_${key}`;
        const previous = s.receipts['deposit:sandbox:' + paymentId];
        const deposits = s.journal.filter(r => r.reason === 'deposit' && r.to === 'wallet:' + userId).reduce((sum,r) => sum+r.amount,0);
        if (!previous && deposits + body.amountCents > 50000) throw code('demo_funding_limit');
        send({ ...money.creditSettledDeposit('sandbox', paymentId, userId, body.amountCents), simulated: true }); return;
      }
      const room = path.match(/^\/api\/rooms\/(room_(?:normal|hard)_(?:1000|5000|10000))\/(join|leave)$/);
      if (room) {
        only(body, ['requestId']); const key = requestId(body.requestId);
        send(room[2] === 'join' ? money.join(room[1], userId, key) : money.leaveLobby(room[1], userId, key)); return;
      }
      if (path === '/api/demo/withdrawals') {
        only(body, ['amountCents', 'requestId']); const key = requestId(body.requestId);
        const result = money.reserveWithdrawal(userId, `payout_${userId}_${key}`, body.amountCents, 'sandbox_' + userId);
        send({ ...result, simulated: true }); return;
      }
      const payout = path.match(/^\/api\/demo\/withdrawals\/([a-zA-Z0-9_-]{1,80})\/resolve$/);
      if (payout) {
        only(body, ['outcome']); const p = money.snapshot().withdrawals[payout[1]];
        if (!p || p.userId !== userId) throw code('not_found', 404);
        send({ ...money.resolveWithdrawal(payout[1], body.outcome), simulated: true }); return;
      }
      throw code('not_found', 404);
    } catch (error) {
      const known = new Set(['insufficient_funds', 'cannot_join', 'cannot_leave', 'idempotency_conflict', 'invalid_cents', 'invalid_outcome', 'invalid_id', 'email_exists', 'invalid_credentials']);
      const status = error.status ?? (known.has(error.message) ? (error.message === 'invalid_credentials' ? 401 : 400) : 500);
      send({ error: status === 500 ? 'internal_error' : error.message }, status);
    }
  });
  return { server, money, close: async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    auth.close(); money.close();
  } };
}
