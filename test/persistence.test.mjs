import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { MoneyEngine } from '../src/monetary-engine.mjs';
import { fixture, verified } from './helpers.mjs';

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'agarmon-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'money.sqlite');
}
function open(databasePath) { return new MoneyEngine({ databasePath, countries: ['ZZ'] }); }
test('restart preserves pending withdrawals and deposit replay protection', t => {
  const databasePath = temporary(t); let e = open(databasePath);
  e.registerUser(verified('u')); e.creditSettledDeposit('sandbox', 'payment', 'u', 1000);
  e.reserveWithdrawal('u', 'payout', 600, 'bank0'); e.markWithdrawalUnknown('payout'); e.close();
  e = open(databasePath);
  try {
    e.creditSettledDeposit('sandbox', 'payment', 'u', 1000);
    assert.equal(e.balance('wallet:u'), 400); assert.equal(e.balance('payout:payout'), 600);
    e.resolveWithdrawal('payout', 'paid'); e.resolveWithdrawal('payout', 'paid'); e.audit();
  } finally { e.close(); }
});
test('running match can settle after server restart', t => {
  const databasePath = temporary(t); const { e } = fixture({ after() {} }, { databasePath });
  e.start('m'); e.eliminate('m', 'p0', 'p1', 'kill'); e.close();
  const resumed = new MoneyEngine({ databasePath, countries: ['ZZ'], clock: () => 300000 });
  try {
    const result = resumed.finish('m'); assert.deepEqual(result.paid, { p0: 875 });
    resumed.finish('m'); assert.equal(resumed.balance('wallet:p0'), 875); resumed.audit();
  } finally { resumed.close(); }
});
test('journal rows reject updates and deletions at the database layer', t => {
  const databasePath = temporary(t), e = open(databasePath);
  e.registerUser(verified('u')); e.creditSettledDeposit('sandbox', 'payment', 'u', 1000); e.close();
  const db = new DatabaseSync(databasePath);
  try {
    assert.throws(() => db.exec('UPDATE movements SET cents = 2000'), /immutable_journal/);
    assert.throws(() => db.exec('DELETE FROM movements'), /immutable_journal/);
  } finally { db.close(); }
});

async function race(t, sameId) {
  const databasePath = temporary(t), e = open(databasePath);
  e.registerUser(verified('u')); e.creditSettledDeposit('sandbox', 'payment', 'u', 1000); e.close();
  const workers = [0, 1].map(i => new Worker(new URL('./withdrawal-worker.mjs', import.meta.url), {
    workerData: { databasePath, payoutId: sameId ? 'same' : 'payout' + i }
  }));
  t.after(async () => { await Promise.all(workers.map(w => w.terminate())); });
  await Promise.all(workers.map(w => once(w, 'message')));
  const outcomes = workers.map(w => once(w, 'message'));
  workers.forEach(w => w.postMessage('go'));
  const results = (await Promise.all(outcomes)).map(([value]) => value);
  const checked = open(databasePath);
  try {
    assert.equal(checked.balance('wallet:u'), 200); checked.audit();
    const reserved = Object.entries(checked.snapshot().accounts).filter(([id]) => id.startsWith('payout:')).reduce((sum, [,n]) => sum + n, 0);
    assert.equal(reserved, 800);
  } finally { checked.close(); }
  return results;
}
test('two separate workers cannot reserve more than the wallet contains', { timeout: 15000 }, async t => {
  const results = await race(t, false);
  assert.equal(results.filter(r => r.success).length, 1);
  assert.equal(results.find(r => !r.success).error, 'insufficient_funds');
});
test('two simultaneous identical payout requests reserve money exactly once', { timeout: 15000 }, async t => {
  const results = await race(t, true); assert.ok(results.every(r => r.success));
  assert.deepEqual(results[0].result, results[1].result);
});
