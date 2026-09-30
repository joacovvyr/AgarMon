import { MoneyEngine } from '../src/monetary-engine.mjs';

export const verified = (id) => ({ id, identityVerified: true, adultVerified: true, residenceCountry: 'ZZ', locationCountry: 'ZZ' });
export function fixture(t, { mode = 'normal', stake = 1000, count = 2, databasePath = ':memory:' } = {}) {
  let now = 0;
  const e = new MoneyEngine({ databasePath, countries: ['ZZ'], clock: () => now });
  t.after(() => e.close());
  for (let i = 0; i < count; i++) {
    e.registerUser(verified('p' + i));
    e.creditSettledDeposit('sandbox', 'd' + i, 'p' + i, stake);
  }
  e.createMatch('m', mode, stake);
  for (let i = 0; i < count; i++) e.join('m', 'p' + i, 'j' + i);
  return { e, time: value => { now = value; } };
}
