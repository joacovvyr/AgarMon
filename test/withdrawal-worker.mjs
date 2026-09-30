import { parentPort, workerData } from 'node:worker_threads';
import { MoneyEngine } from '../src/monetary-engine.mjs';
const e = new MoneyEngine({ databasePath: workerData.databasePath, countries: ['ZZ'] });
parentPort.postMessage({ ready: true });
parentPort.once('message', () => {
  try {
    const result = e.reserveWithdrawal('u', workerData.payoutId, 800, 'bank0');
    parentPort.postMessage({ success: true, result });
  } catch (error) { parentPort.postMessage({ success: false, error: error.message }); }
  finally { e.close(); }
});
