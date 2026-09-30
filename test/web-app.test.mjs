import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createWebApp } from '../src/web-app.mjs';

const password = 'AgarMon-tests-only-1234';
async function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'agarmon-web-'));
  const app = createWebApp({ dataDirectory: directory });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  function client() {
    let cookie = '', csrf = '';
    return {
      async call(path, body, overrides = {}) {
        const method = body === undefined ? 'GET' : 'POST';
        const response = await fetch(base + path, { method, headers: {
          'Content-Type': 'application/json', Origin: base, Cookie: cookie, 'X-CSRF-Token': csrf, ...overrides
        }, body: body === undefined ? undefined : JSON.stringify(body) });
        const nextCookie = response.headers.get('set-cookie'); if (nextCookie) cookie = nextCookie.split(';')[0];
        const data = await response.json(); if (data.csrf) csrf = data.csrf;
        return { response, data };
      },
      async register(email = 'user@example.com') { return this.call('/api/register', { email, password, name: 'Jugador' }); },
      async funds(requestId = 'deposit1') { return this.call('/api/demo/funds', { amountCents: 10000, requestId }); }
    };
  }
  return { app, base, client, directory };
}
test('web serves responsive app and restricts static paths', async t => {
  const { base } = await setup(t); const response = await fetch(base);
  assert.equal(response.status, 200); const html = await response.text();
  assert.match(html, /Fondos simulados/); assert.match(html, /name="viewport"/);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const blocked = await fetch(base + '/src/monetary-engine.mjs'); assert.equal(blocked.status, 404);
});
test('register hashes passwords, issues HttpOnly session, rotates login and logs out', async t => {
  const { client, directory } = await setup(t); const c = client();
  const registered = await c.register(); assert.equal(registered.response.status, 201);
  assert.match(registered.response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const db = new DatabaseSync(join(directory, 'auth.sqlite'));
  const stored = db.prepare('SELECT password_hash FROM users').get().password_hash; db.close();
  assert.notEqual(stored, password); assert.equal(stored.length, 128);
  const beforeCookie = registered.response.headers.get('set-cookie');
  const logged = await c.call('/api/login', { email: 'user@example.com', password });
  assert.equal(logged.response.status, 200); assert.notEqual(logged.response.headers.get('set-cookie'), beforeCookie);
  assert.equal((await c.call('/api/state')).data.user.email, 'user@example.com');
  assert.equal((await c.call('/api/logout', {})).response.status, 200);
  assert.equal((await c.call('/api/state')).data.user, null);
});
test('anonymous user cannot fund a wallet', async t => {
  const { client } = await setup(t); const c = client(); const result = await c.funds();
  assert.equal(result.response.status, 401);
});
test('cross-origin or CSRF-less changes cannot move funds', async t => {
  const { client } = await setup(t); const c = client(); await c.register();
  const a = await c.call('/api/demo/funds', { amountCents:10000, requestId:'x' }, { Origin:'https://foreign.example' });
  assert.equal(a.response.status, 403);
  const b = await c.call('/api/demo/funds', { amountCents:10000, requestId:'y' }, { 'X-CSRF-Token':'' });
  assert.equal(b.response.status, 403); assert.equal((await c.call('/api/state')).data.balanceCents, 0);
});
test('browser fields cannot impersonate a user or assert verified identity', async t => {
  const { client } = await setup(t); const c = client(); await c.register();
  const bad = await c.call('/api/demo/funds', { amountCents:10000, requestId:'x', userId:'victim' }); assert.equal(bad.response.status, 400);
  const register = await client().call('/api/register', { email:'other@example.com', password, name:'Other', identityVerified:true }); assert.equal(register.response.status, 400);
  const unavailable = await c.call('/api/eliminate', {}); assert.equal(unavailable.response.status, 404);
});
test('browser funds, entry reservation and refund match the durable ledger', async t => {
  const { client, app } = await setup(t); const c = client(); await c.register();
  await c.funds(); await c.funds(); assert.equal((await c.call('/api/state')).data.balanceCents, 10000);
  await c.call('/api/rooms/room_normal_1000/join', { requestId:'join1' });
  const joined = (await c.call('/api/state')).data;
  assert.equal(joined.balanceCents, 9000); assert.equal(joined.reservedCents, 1000);
  await c.call('/api/rooms/room_normal_1000/leave', { requestId:'leave1' });
  const left = (await c.call('/api/state')).data; assert.equal(left.balanceCents, 10000); assert.equal(left.reservedCents, 0);
  assert.equal(app.money.audit().balanced, true);
});
test('funding sandbox enforces lifetime cap and rejects arbitrary money values', async t => {
  const { client } = await setup(t); const c = client(); await c.register();
  for(let i=0;i<5;i++) assert.equal((await c.funds('deposit'+i)).response.status,200);
  assert.equal((await c.funds('overflow')).response.status,400);
  assert.equal((await c.call('/api/demo/funds',{amountCents:0.1,requestId:'float'})).response.status,400);
});
test('pending withdrawal survives refresh, belongs to its user, and refunds once', async t => {
  const { client } = await setup(t); const a = client(), b = client();
  await a.register('a@example.com'); await b.register('b@example.com'); await a.funds();
  const reserved = await a.call('/api/demo/withdrawals',{amountCents:2500,requestId:'withdraw1'});
  const payoutId = reserved.data.payoutId;
  assert.equal((await a.call('/api/state')).data.balanceCents,7500);
  assert.equal((await a.call('/api/state')).data.withdrawals[0].id,payoutId);
  assert.equal((await b.call('/api/state')).data.withdrawals.length,0);
  assert.equal((await b.call(`/api/demo/withdrawals/${payoutId}/resolve`,{outcome:'paid'})).response.status,404);
  await a.call(`/api/demo/withdrawals/${payoutId}/resolve`,{outcome:'failed'});
  await a.call(`/api/demo/withdrawals/${payoutId}/resolve`,{outcome:'failed'});
  assert.equal((await a.call('/api/state')).data.balanceCents,10000);
});
test('sandbox confirms a withdrawal exactly once without a live provider', async t => {
  const { client, app } = await setup(t); const c = client(); await c.register(); await c.funds();
  const response = await c.call('/api/demo/withdrawals',{amountCents:1500,requestId:'withdraw1'});
  const path = `/api/demo/withdrawals/${response.data.payoutId}/resolve`;
  const paid = await c.call(path,{outcome:'paid'}); assert.equal(paid.data.simulated,true);
  await c.call(path,{outcome:'paid'}); assert.equal((await c.call('/api/state')).data.balanceCents,8500);
  assert.equal((await c.call(path,{outcome:'failed'})).response.status,400); app.money.audit();
});
test('live mode and malformed origin cannot accidentally enable the sandbox identities', () => {
  assert.throws(() => createWebApp({mode:'live',dataDirectory:'/unused'}), /live_mode_not_implemented/);
  assert.throws(() => createWebApp({publicOrigin:'https://example.com/path',dataDirectory:'/unused'}), /invalid_public_origin/);
});
