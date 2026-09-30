import { createWebApp } from './web-app.mjs';
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('invalid_port');
const host = process.env.HOST ?? '127.0.0.1';
const app = createWebApp({
  dataDirectory: process.env.AGARMON_DATA_DIR ?? './data',
  publicOrigin: process.env.PUBLIC_ORIGIN,
  mode: process.env.AGARMON_MODE ?? 'sandbox'
});
app.server.listen(port, host, () => console.log(`AgarMon web · fondos simulados · ${process.env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:' + port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().then(() => process.exit(0)));
