import { MoneyEngine } from '../src/monetary-engine.mjs';
let now = 0;
const e = new MoneyEngine({ countries: ['ZZ'], clock: () => now });
try {
  for (const name of ['alice', 'bob']) {
    e.registerUser({ id: name, identityVerified: true, adultVerified: true, residenceCountry: 'ZZ', locationCountry: 'ZZ' });
    e.creditSettledDeposit('sandbox', 'payment_' + name, name, 1000);
  }
  e.createMatch('demo', 'normal', 1000);
  e.join('demo', 'alice', 'join_a'); e.join('demo', 'bob', 'join_b'); e.start('demo');
  const elimination = e.eliminate('demo', 'alice', 'bob', 'kill_b');
  now = 60000; const extraction = e.extract('demo', 'alice', 'extract_a');
  now = 300000; const settlement = e.finish('demo');
  console.log(JSON.stringify({
    simulated: true, currency: 'USD', amountsIn: 'integer cents',
    deposited: 2000, elimination, extraction, settlement,
    aliceWallet: e.balance('wallet:alice'),
    houseTotal: e.balance('house:fees') + e.balance('house:uncollected'), audit: e.audit()
  }, null, 2));
} finally { e.close(); }
