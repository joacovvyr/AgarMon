import { SQLiteStore } from './sqlite-store.mjs';

const clone = (value) => structuredClone(value);
const own = (obj, key) => Object.hasOwn(obj, key);
const MAX_CENTS = 1_000_000_000; // USD 10M per operation; safe arithmetic at this stage.
function id(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value))
    throw Error('invalid_id');
  return value;
}
function cents(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_CENTS) throw Error('invalid_cents');
  return value;
}
const wallet = (userId) => 'wallet:' + id(userId);
const account = (m, kind, userId = '') => `match:${m.id}:${kind}${userId ? ':' + id(userId) : ''}`;
function amount(state, name) { return state.accounts[name] ?? 0; }
function move(state, from, to, value, reason) {
  cents(value);
  if (from === to) throw Error('same_account');
  if (from !== 'provider:clearing' && amount(state, from) < value) throw Error('insufficient_funds');
  const debit = amount(state, from) - value, credit = amount(state, to) + value;
  if (!Number.isSafeInteger(debit) || !Number.isSafeInteger(credit)) throw Error('amount_overflow');
  state.accounts[from] = debit; state.accounts[to] = credit;
  state.journal.push({ sequence: state.journal.length + 1, from, to, amount: value, reason });
}

/** Trusted-server monetary core. No public API, live gateway, identity proof or collision verification. */
export class MoneyEngine {
  #store; #countries; #clock; #duration;
  constructor({ databasePath = ':memory:', countries = [], durationMs = 300_000, clock = Date.now } = {}) {
    if (!Number.isSafeInteger(durationMs) || durationMs <= 120_000 || durationMs > 3_600_000) throw Error('invalid_duration');
    this.#store = new SQLiteStore(databasePath); this.#countries = new Set(countries);
    this.#clock = clock; this.#duration = durationMs;
  }
  close() { this.#store.close(); }
  snapshot() { return this.#store.read(); }
  balance(name) { return amount(this.snapshot(), name); }
  #now() { const n = this.#clock(); if (!Number.isSafeInteger(n) || n < 0) throw Error('invalid_server_time'); return n; }
  #atomic(key, input, fn) {
    const fingerprint = JSON.stringify(input);
    return this.#store.transaction(state => {
      const prior = state.receipts[key];
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw Error('idempotency_conflict');
        return clone(prior.result);
      }
      const result = fn(state);
      state.receipts[key] = { fingerprint, result };
      this.#audit(state); return result;
    });
  }
  #eligible(state, userId) {
    id(userId); const u = state.users[userId];
    if (!u || u.identityVerified !== true || u.adultVerified !== true || u.suspended || u.selfExcluded) throw Error('user_ineligible');
    if (u.residenceCountry === 'UY' || u.locationCountry === 'UY' ||
        !this.#countries.has(u.residenceCountry) || !this.#countries.has(u.locationCountry)) throw Error('country_not_enabled');
  }
  // Only a trusted identity service may set these fields. These are assertions, not KYC implementations.
  registerUser(user) {
    id(user.id);
    const data = {
      id: user.id, identityVerified: user.identityVerified === true, adultVerified: user.adultVerified === true,
      residenceCountry: user.residenceCountry ?? null, locationCountry: user.locationCountry ?? null,
      suspended: user.suspended === true, selfExcluded: user.selfExcluded === true
    };
    return this.#atomic('register:' + user.id, data, s => {
      if (own(s.users, user.id)) throw Error('user_exists');
      s.users[user.id] = data; return { userId: user.id };
    });
  }
  updateEligibility(userId, patch, eventId) {
    id(userId); id(eventId);
    const allowed = ['identityVerified', 'adultVerified', 'residenceCountry', 'locationCountry', 'suspended', 'selfExcluded'];
    if (Object.keys(patch).some(k => !allowed.includes(k))) throw Error('invalid_eligibility_fields');
    return this.#atomic('eligibility:' + userId + ':' + eventId, [userId, patch], s => {
      if (!own(s.users, userId)) throw Error('user_not_found');
      Object.assign(s.users[userId], clone(patch)); return { userId };
    });
  }
  // Trusted gateway adapter ONLY, after verifying final settled status, recipient, currency and amount.
  creditSettledDeposit(provider, paymentId, userId, value) {
    id(provider); id(paymentId); id(userId); cents(value);
    return this.#atomic('deposit:' + provider + ':' + paymentId, [userId, value, 'USD'], s => {
      this.#eligible(s, userId); move(s, 'provider:clearing', wallet(userId), value, 'deposit');
      return { userId, amount: value, status: 'credited' };
    });
  }
  createMatch(matchId, mode, entryCents) {
    id(matchId);
    if (!['normal', 'hard'].includes(mode)) throw Error('invalid_mode');
    if (![1000, 5000, 10000].includes(entryCents)) throw Error('invalid_entry');
    return this.#atomic('create:' + matchId, [matchId, mode, entryCents, this.#duration], s => {
      s.matches[matchId] = { id: matchId, mode, entryCents, durationMs: this.#duration, phase: 'lobby', players: {}, pellets: {}, counter: 0 };
      return { matchId, mode, entryCents };
    });
  }
  #match(state, matchId) { id(matchId); if (!own(state.matches, matchId)) throw Error('match_not_found'); return state.matches[matchId]; }
  #active(state, matchId, userId) {
    id(userId); const m = this.#match(state, matchId), now = this.#now();
    if (m.phase !== 'running' || now < m.startedAt || now >= m.endsAt || m.players[userId]?.status !== 'alive') throw Error('not_active');
    return m;
  }
  join(matchId, userId, requestId) {
    id(userId); id(requestId);
    return this.#atomic('join:' + userId + ':' + requestId, [matchId, userId], s => {
      this.#eligible(s, userId); const m = this.#match(s, matchId);
      if (m.phase !== 'lobby' || own(m.players, userId)) throw Error('cannot_join');
      move(s, wallet(userId), account(m, 'entry', userId), m.entryCents, 'reserve_entry');
      m.players[userId] = { status: 'queued' }; return { reservedCents: m.entryCents };
    });
  }
  #gold(m, value) {
    const unit = m.entryCents / 200;
    while (value > 0) { const n = Math.min(unit, value); m.pellets['gold-' + (++m.counter)] = n; value -= n; }
  }
  leaveLobby(matchId, userId, requestId) {
    id(userId); id(requestId);
    return this.#atomic('leave:' + userId + ':' + requestId, [matchId, userId], s => {
      const m = this.#match(s, matchId);
      if (m.phase !== 'lobby' || m.players[userId]?.status !== 'queued') throw Error('cannot_leave');
      move(s, account(m, 'entry', userId), wallet(userId), m.entryCents, 'leave_lobby_refund');
      delete m.players[userId]; return { refundedCents: m.entryCents };
    });
  }
  start(matchId) {
    return this.#atomic('start:' + matchId, [matchId], s => {
      const m = this.#match(s, matchId), players = Object.keys(m.players);
      if (m.phase !== 'lobby' || players.length < 2) throw Error('cannot_start');
      for (const userId of players) this.#eligible(s, userId);
      m.startedAt = this.#now(); m.endsAt = m.startedAt + m.durationMs; m.phase = 'running';
      for (const userId of players) {
        const from = account(m, 'entry', userId), fee = m.entryCents / 4;
        move(s, from, account(m, 'active', userId), m.entryCents / 2, 'initial_player_value');
        move(s, from, account(m, 'pending_fee'), fee, 'pending_house_fee');
        move(s, from, account(m, 'world'), fee, 'initial_world_value');
        this.#gold(m, fee); m.players[userId].status = 'alive';
      }
      return { startedAt: m.startedAt, endsAt: m.endsAt };
    });
  }
  // Collision must already have been validated by the authoritative game server.
  collect(matchId, userId, pelletId, eventId) {
    id(pelletId); id(eventId);
    return this.#atomic('collect:' + matchId + ':' + eventId, [userId, pelletId], s => {
      const m = this.#active(s, matchId, userId), value = m.pellets[pelletId];
      if (!value) throw Error('pellet_unavailable');
      move(s, account(m, 'world'), account(m, 'active', userId), value, 'collect_gold');
      delete m.pellets[pelletId]; return { amount: value };
    });
  }
  eliminate(matchId, attackerId, victimId, eventId) {
    id(eventId);
    return this.#atomic('eliminate:' + matchId + ':' + eventId, [attackerId, victimId], s => {
      if (attackerId === victimId) throw Error('self_elimination');
      const m = this.#active(s, matchId, attackerId); this.#active(s, matchId, victimId);
      const from = account(m, 'active', victimId), total = amount(s, from);
      const attacker = Math.floor(total / 4) * 3 + Math.floor((total % 4) * 3 / 4), world = total - attacker;
      if (attacker) move(s, from, account(m, 'active', attackerId), attacker, 'elimination_award');
      if (world) { move(s, from, account(m, 'world'), world, 'elimination_drop'); this.#gold(m, world); }
      m.players[victimId].status = 'eliminated'; return { total, attacker, world };
    });
  }
  extract(matchId, userId, requestId) {
    id(userId); id(requestId);
    return this.#atomic('extract:' + userId + ':' + requestId, [matchId, userId], s => {
      const m = this.#active(s, matchId, userId), elapsed = this.#now() - m.startedAt;
      if (m.mode !== 'normal' || elapsed < 60_000 || elapsed >= 120_000) throw Error('extraction_closed');
      const from = account(m, 'active', userId), value = amount(s, from);
      if (value) move(s, from, wallet(userId), value, 'match_extraction');
      m.players[userId].status = 'extracted'; return { amount: value, status: 'extracted' };
    });
  }
  finish(matchId) {
    return this.#atomic('finish:' + matchId, [matchId], s => {
      const m = this.#match(s, matchId);
      if (m.phase !== 'running' || this.#now() < m.endsAt) throw Error('cannot_finish');
      const paid = {};
      for (const [userId, player] of Object.entries(m.players)) {
        if (player.status !== 'alive') continue;
        const from = account(m, 'active', userId), value = amount(s, from);
        if (value) move(s, from, wallet(userId), value, 'survivor_settlement');
        player.status = 'settled'; paid[userId] = value;
      }
      const remainingGold = amount(s, account(m, 'world')), fee = amount(s, account(m, 'pending_fee'));
      if (remainingGold) move(s, account(m, 'world'), 'house:uncollected', remainingGold, 'uncollected_gold');
      if (fee) move(s, account(m, 'pending_fee'), 'house:fees', fee, 'recognize_house_fee');
      m.pellets = {}; m.phase = 'settled'; return { paid, remainingGold, fee };
    });
  }
  cancelLobby(matchId) {
    return this.#atomic('cancel:' + matchId, [matchId], s => {
      const m = this.#match(s, matchId); if (m.phase !== 'lobby') throw Error('only_lobby_cancel_supported');
      for (const userId of Object.keys(m.players)) {
        move(s, account(m, 'entry', userId), wallet(userId), m.entryCents, 'entry_refund');
        m.players[userId].status = 'refunded';
      }
      m.phase = 'cancelled'; return { status: 'cancelled' };
    });
  }
  reserveWithdrawal(userId, payoutId, value, destinationRef) {
    id(userId); id(payoutId); id(destinationRef); cents(value);
    return this.#atomic('withdrawal:' + payoutId, [userId, value, destinationRef], s => {
      const u = s.users[userId];
      // Wagering restrictions must not silently seize existing funds.
      if (!u || u.identityVerified !== true || u.adultVerified !== true) throw Error('withdrawal_identity_required');
      move(s, wallet(userId), 'payout:' + payoutId, value, 'reserve_withdrawal');
      s.withdrawals[payoutId] = { userId, amount: value, destinationRef, status: 'reserved' };
      return { payoutId, amount: value, destinationRef, status: 'reserved' };
    });
  }
  markWithdrawalUnknown(payoutId) {
    id(payoutId);
    return this.#atomic('unknown:' + payoutId, [payoutId], s => {
      const p = s.withdrawals[payoutId]; if (!p || p.status !== 'reserved') throw Error('invalid_payout_state');
      p.status = 'unknown'; return { status: 'unknown' };
    });
  }
  // Trusted provider adapter must validate destination, payout reference, amount and terminal outcome.
  resolveWithdrawal(payoutId, outcome) {
    id(payoutId); if (!['paid', 'failed'].includes(outcome)) throw Error('invalid_outcome');
    return this.#atomic('resolve:' + payoutId, [payoutId, outcome], s => {
      const p = s.withdrawals[payoutId];
      if (!p || !['reserved', 'unknown'].includes(p.status)) throw Error('invalid_payout_state');
      move(s, 'payout:' + payoutId, outcome === 'paid' ? 'provider:clearing' : wallet(p.userId), p.amount, 'withdrawal_' + outcome);
      p.status = outcome; return { status: outcome, amount: p.amount };
    });
  }
  #audit(s) {
    let total = 0; const rebuilt = {};
    for (const [name, value] of Object.entries(s.accounts)) {
      if (!Number.isSafeInteger(value) || (name !== 'provider:clearing' && value < 0)) throw Error('invalid_balance');
      total += value; if (!Number.isSafeInteger(total)) throw Error('audit_overflow');
    }
    if (total !== 0) throw Error('unbalanced_ledger');
    for (const [index, row] of s.journal.entries()) {
      cents(row.amount); if (row.sequence !== index + 1 || row.from === row.to) throw Error('invalid_journal');
      rebuilt[row.from] = (rebuilt[row.from] ?? 0) - row.amount;
      rebuilt[row.to] = (rebuilt[row.to] ?? 0) + row.amount;
    }
    for (const name of new Set([...Object.keys(rebuilt), ...Object.keys(s.accounts)]))
      if ((rebuilt[name] ?? 0) !== amount(s, name)) throw Error('journal_mismatch');
    for (const m of Object.values(s.matches)) {
      const gold = Object.values(m.pellets).reduce((sum, value) => sum + cents(value), 0);
      if (gold !== amount(s, account(m, 'world'))) throw Error('world_backing_mismatch');
      for (const [userId, p] of Object.entries(m.players))
        if (['eliminated', 'extracted', 'settled'].includes(p.status) && amount(s, account(m, 'active', userId)) !== 0)
          throw Error('inactive_player_has_value');
    }
    for (const [payoutId, p] of Object.entries(s.withdrawals))
      if (amount(s, 'payout:' + payoutId) !== (['reserved', 'unknown'].includes(p.status) ? p.amount : 0)) throw Error('payout_backing_mismatch');
    return { balanced: true, journalEntries: s.journal.length };
  }
  audit() { const report = this.#audit(this.snapshot()); return { ...report, ...this.#store.verify() }; }
}
