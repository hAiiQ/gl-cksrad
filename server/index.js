import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { createApp } from './app.js';

const production = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT) || 3000;
const appUrl = (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`).replace(/\/$/, '');
if (production && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32 || !process.env.ADMIN_PASSWORD)) {
  throw new Error('In Produktion SESSION_SECRET (mindestens 32 Zeichen) und ADMIN_PASSWORD setzen.');
}
if (!process.env.ADMIN_PASSWORD) throw new Error('Bitte ADMIN_PASSWORD in der .env oder in den Umgebungsvariablen setzen.');
if (production && !appUrl.startsWith('https://')) throw new Error('APP_URL muss in Produktion HTTPS verwenden.');
const config = {
  production, appUrl,
  sessionSecret: process.env.SESSION_SECRET || randomBytes(48).toString('hex'),
  adminPassword: process.env.ADMIN_PASSWORD,
  dataDir: process.env.DATA_DIR || './data',
};
const instance = createApp(config);
const server = instance.app.listen(port, '0.0.0.0', () => {
  console.log(`Glücksrad läuft auf ${appUrl}`);
});
function shutdown() {
  server.close(() => { instance.close(); process.exit(0); });
  server.closeIdleConnections();
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
