import test from 'node:test';
import assert from 'node:assert/strict';
import { MoneyEngine } from '../src/monetary-engine.mjs';
import { fixture, verified } from './helpers.mjs';

const rejects = (fn, message) => assert.throws(fn, error => error.message === message);

test('25/50/25 allocation across all three entry tiers', t => {
  for (const stake of [1000, 5000, 10000]) {
    const { e } = fixture(t, { stake }); e.start('m');
    assert.equal(e.balance('match:m:active:p0'), stake / 2);
    assert.equal(e.balance('match:m:world'), stake / 2);
    assert.equal(e.balance('match:m:pending_fee'), stake / 2);
    assert.equal(e.audit().balanced, true);
  }
});
test('repeated deposit notifications cannot double-credit a payment', t => {
  const { e } = fixture(t), before = e.snapshot();
  e.creditSettledDeposit('sandbox', 'd0', 'p0', 1000);
  assert.deepEqual(e.snapshot(), before);
  rejects(() => e.creditSettledDeposit('sandbox', 'd0', 'p0', 1001), 'idempotency_conflict');
  rejects(() => e.creditSettledDeposit('sandbox', 'd0', 'p1', 1000), 'idempotency_conflict');
});
test('entry without funds rolls back every change', t => {
  const { e } = fixture(t); e.createMatch('other', 'normal', 1000); const before = e.snapshot();
  rejects(() => e.join('other', 'p0', 'otherjoin'), 'insufficient_funds');
  assert.deepEqual(e.snapshot(), before);
});
test('duplicate membership is rejected even with a fresh request ID', t => {
  const { e } = fixture(t); rejects(() => e.join('m', 'p0', 'fresh'), 'cannot_join');
});
test('replayed start does not issue more money', t => {
  const { e } = fixture(t); e.start('m'); const before = e.snapshot(); e.start('m'); assert.deepEqual(e.snapshot(), before);
});
test('75/25 elimination transfers money without changing its total', t => {
  const { e } = fixture(t); e.start('m');
  assert.deepEqual(e.eliminate('m', 'p0', 'p1', 'kill'), { total: 500, attacker: 375, world: 125 });
  assert.equal(e.balance('match:m:active:p1'), 0);
  assert.equal(e.balance('match:m:active:p0'), 875);
  assert.equal(e.balance('match:m:world'), 625);
  const before = e.snapshot(); e.eliminate('m', 'p0', 'p1', 'kill'); assert.deepEqual(e.snapshot(), before);
});
test('fractional cents go to the world remainder', t => {
  for (let n = 0; n < 4; n++) {
    const { e } = fixture(t); e.start('m');
    for (let k = 0; k < n; k++) e.collect('m', 'p1', 'gold-' + (k + 1), 'collect-' + k);
    const result = e.eliminate('m', 'p0', 'p1', 'kill');
    assert.equal(result.total, 500 + n * 5);
    assert.equal(result.attacker, Math.floor(result.total * 0.75));
    assert.equal(result.attacker + result.world, result.total); e.audit();
  }
});
test('gold cannot be collected twice, including by another player', t => {
  const { e } = fixture(t); e.start('m'); e.collect('m', 'p0', 'gold-1', 'c1'); const before = e.snapshot();
  rejects(() => e.collect('m', 'p1', 'gold-1', 'c2'), 'pellet_unavailable');
  assert.deepEqual(e.snapshot(), before); e.collect('m', 'p0', 'gold-1', 'c1'); assert.deepEqual(e.snapshot(), before);
});
test('normal extraction opens exactly at 60 seconds', t => {
  const { e, time } = fixture(t); e.start('m'); time(59999);
  rejects(() => e.extract('m', 'p0', 'early'), 'extraction_closed');
  time(60000); assert.equal(e.extract('m', 'p0', 'yes').amount, 500);
});
test('normal extraction closes exactly at 120 seconds', t => {
  const a = fixture(t); a.e.start('m'); a.time(119999); assert.equal(a.e.extract('m', 'p0', 'yes').amount, 500);
  const b = fixture(t); b.e.start('m'); b.time(120000); rejects(() => b.e.extract('m', 'p0', 'late'), 'extraction_closed');
});
test('hard never allows early extraction', t => {
  const { e, time } = fixture(t, { mode: 'hard' }); e.start('m'); time(90000);
  rejects(() => e.extract('m', 'p0', 'no'), 'extraction_closed');
});
test('all hard survivors receive their own balances and house takes remaining gold', t => {
  const { e, time } = fixture(t, { mode: 'hard' }); e.start('m'); time(300000);
  assert.deepEqual(e.finish('m'), { paid: { p0: 500, p1: 500 }, remainingGold: 500, fee: 500 });
  assert.equal(e.balance('wallet:p0'), 500); assert.equal(e.balance('house:fees'), 500);
  assert.equal(e.balance('house:uncollected'), 500);
});
test('expiry must occur before settlement; replay never pays twice', t => {
  const { e, time } = fixture(t); e.start('m'); time(299999); rejects(() => e.finish('m'), 'cannot_finish');
  time(300000); e.finish('m'); const before = e.snapshot(); e.finish('m'); assert.deepEqual(e.snapshot(), before);
  rejects(() => e.collect('m', 'p0', 'gold-1', 'late'), 'not_active');
});
test('extraction first prevents a later elimination from spending that value', t => {
  const { e, time } = fixture(t); e.start('m'); time(60000); e.extract('m', 'p1', 'out'); const before = e.snapshot();
  rejects(() => e.eliminate('m', 'p0', 'p1', 'kill'), 'not_active'); assert.deepEqual(e.snapshot(), before);
});
test('elimination first prevents a later extraction from paying that value', t => {
  const { e, time } = fixture(t); e.start('m'); time(60000); e.eliminate('m', 'p0', 'p1', 'kill'); const before = e.snapshot();
  rejects(() => e.extract('m', 'p1', 'out'), 'not_active'); assert.deepEqual(e.snapshot(), before);
});
test('cancelling a lobby refunds whole entries and collects no fee', t => {
  const { e } = fixture(t); e.cancelLobby('m');
  assert.equal(e.balance('wallet:p0'), 1000); assert.equal(e.balance('wallet:p1'), 1000); assert.equal(e.balance('house:fees'), 0); e.audit();
});
test('leave lobby returns only that user entry and can be safely replayed', t => {
  const { e } = fixture(t); e.leaveLobby('m', 'p0', 'leave'); const before = e.snapshot();
  e.leaveLobby('m', 'p0', 'leave'); assert.deepEqual(e.snapshot(), before);
  assert.equal(e.balance('wallet:p0'), 1000); assert.equal(e.balance('wallet:p1'), 0);
  assert.equal(e.snapshot().matches.m.players.p0, undefined);
  e.join('m', 'p0', 'rejoin'); assert.equal(e.balance('wallet:p0'), 0); e.audit();
});
test('leave is rejected once a match starts', t => {
  const { e } = fixture(t); e.start('m'); const before = e.snapshot();
  rejects(() => e.leaveLobby('m', 'p0', 'leave'), 'cannot_leave'); assert.deepEqual(e.snapshot(), before);
});
test('active match cancellation is explicitly unsupported, not a partial refund', t => {
  const { e } = fixture(t); e.start('m'); const before = e.snapshot();
  rejects(() => e.cancelLobby('m'), 'only_lobby_cancel_supported'); assert.deepEqual(e.snapshot(), before);
});
test('withdrawal reserves once and failed payout returns funds once', t => {
  const { e } = fixture(t); e.cancelLobby('m'); e.reserveWithdrawal('p0', 'w1', 600, 'bank0'); e.reserveWithdrawal('p0', 'w1', 600, 'bank0');
  assert.equal(e.balance('wallet:p0'), 400);
  e.resolveWithdrawal('w1', 'failed'); e.resolveWithdrawal('w1', 'failed'); assert.equal(e.balance('wallet:p0'), 1000);
  rejects(() => e.resolveWithdrawal('w1', 'paid'), 'idempotency_conflict');
});
test('withdrawal ID binds user, amount and destination', t => {
  const { e } = fixture(t); e.cancelLobby('m'); e.reserveWithdrawal('p0', 'w1', 600, 'bank0');
  rejects(() => e.reserveWithdrawal('p0', 'w1', 600, 'bank1'), 'idempotency_conflict');
  rejects(() => e.reserveWithdrawal('p1', 'w1', 600, 'bank0'), 'idempotency_conflict');
});
test('unknown payout keeps funds reserved until a verified outcome', t => {
  const { e } = fixture(t); e.cancelLobby('m'); e.reserveWithdrawal('p0', 'w1', 600, 'bank0'); e.markWithdrawalUnknown('w1');
  assert.equal(e.balance('wallet:p0'), 400); assert.equal(e.balance('payout:w1'), 600);
  e.resolveWithdrawal('w1', 'paid'); assert.equal(e.balance('payout:w1'), 0); assert.equal(e.balance('wallet:p0'), 400); e.audit();
});
test('Uruguay is denied for residence and location, even in the allowlist', t => {
  for (const field of ['residenceCountry', 'locationCountry']) {
    const e = new MoneyEngine({ countries: ['ZZ', 'UY'] }); t.after(() => e.close());
    e.registerUser({ ...verified('u'), [field]: 'UY' });
    rejects(() => e.creditSettledDeposit('sandbox', 'p', 'u', 1000), 'country_not_enabled');
  }
});
test('no countries enabled by default', t => {
  const e = new MoneyEngine(); t.after(() => e.close()); e.registerUser(verified('u'));
  rejects(() => e.creditSettledDeposit('sandbox', 'p', 'u', 1000), 'country_not_enabled');
});
test('self-exclusion blocks wagering without preventing return of held funds', t => {
  const { e } = fixture(t); e.cancelLobby('m'); e.updateEligibility('p0', { selfExcluded: true }, 'exclude'); e.createMatch('new', 'normal', 1000);
  rejects(() => e.join('new', 'p0', 'new'), 'user_ineligible'); e.reserveWithdrawal('p0', 'returnfunds', 1000, 'bank0'); e.audit();
});
test('money fractions, unsafe integers, nonfinite values and prototype IDs reject', t => {
  const { e } = fixture(t);
  for (const value of [0, -1, 0.1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
    rejects(() => e.reserveWithdrawal('p0', 'w', value, 'bank0'), 'invalid_cents');
  rejects(() => e.createMatch('__proto__', 'normal', 1000), 'invalid_id');
  rejects(() => e.createMatch('other', 'hard', 1001), 'invalid_entry');
});
test('returned snapshots cannot mutate persisted balances', t => {
  const { e } = fixture(t); const state = e.snapshot(); state.accounts['wallet:p0'] = 12345;
  assert.equal(e.balance('wallet:p0'), 0); e.audit();
});
test('changed eligibility is rechecked when a queued match starts', t => {
  const { e } = fixture(t); e.updateEligibility('p0', { locationCountry: 'UY' }, 'move');
  rejects(() => e.start('m'), 'country_not_enabled'); assert.equal(e.snapshot().matches.m.phase, 'lobby');
  e.cancelLobby('m'); assert.equal(e.balance('wallet:p0'), 1000);
});
test('500 seeded match lifecycles preserve every deposited cent', t => {
  let seed = 1729;
  const rand = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let round = 0; round < 500; round++) {
    const stake = [1000, 5000, 10000][rand(3)];
    // Close each database immediately instead of holding 500 connections until test cleanup.
    const { e, time } = fixture({ after() {} }, { mode: rand(2) ? 'normal' : 'hard', stake, count: 5 });
    try {
      e.start('m');
      for (let step = 0; step < 25; step++) {
        time(1000 + step * 8000); const m = e.snapshot().matches.m;
        const alive = Object.keys(m.players).filter(p => m.players[p].status === 'alive');
        if (!alive.length) break;
        const player = alive[rand(alive.length)], gold = Object.keys(m.pellets), choice = rand(3);
        if (choice === 0 && gold.length) e.collect('m', player, gold[rand(gold.length)], 'c' + step);
        else if (choice === 1 && alive.length > 1) {
          const others = alive.filter(p => p !== player); e.eliminate('m', player, others[rand(others.length)], 'k' + step);
        } else if (m.mode === 'normal' && step >= 8 && step < 15) e.extract('m', player, 'e' + step);
      }
      time(300000); e.finish('m'); e.audit();
      const wallets = [0, 1, 2, 3, 4].reduce((sum, i) => sum + e.balance('wallet:p' + i), 0);
      const house = e.balance('house:fees') + e.balance('house:uncollected');
      assert.equal(wallets + house, stake * 5);
    } finally { e.close(); }
  }
});
