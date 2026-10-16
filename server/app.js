import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { createHmac, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDatabase, SQLiteSessionStore } from './database.js';

const saveSession = (req) => new Promise((resolve, reject) => req.session.save((e) => e ? reject(e) : resolve()));
const regenerate = (req) => new Promise((resolve, reject) => req.session.regenerate((e) => e ? reject(e) : resolve()));
const ADMIN_TTL = 4 * 60 * 60 * 1000;
const PARTICIPANT_COOKIE = 'herbi.participant';

function cleanName(value) {
  if (typeof value !== 'string') return null;
  const name = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (Array.from(name).length < 2 || Array.from(name).length > 32 || /[\p{Cc}\p{Cf}]/u.test(name)) return null;
  return name;
}
const nameKey = (name) => name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('de-DE');

export function createApp(config, overrides = {}) {
  const app = express();
  const db = overrides.db || openDatabase(config.dataDir);
  const store = new SQLiteSessionStore(db, config.sessionSecret);
  const clients = new Set();
  let finishTimer;
  const passwordSalt = randomBytes(16);
  const passwordHash = scryptSync(config.adminPassword, passwordSalt, 64);
  const signature = (id) => createHmac('sha256', config.sessionSecret).update(`participant:${id}`).digest('hex');
  function rememberParticipant(res, id) {
    res.cookie(PARTICIPANT_COOKIE, `${id}.${signature(id)}`, {
      httpOnly: true, secure: config.production, sameSite: 'lax', maxAge: 365 * 86_400_000,
    });
  }
  function readParticipant(req) {
    const value = req.headers.cookie?.split(';').map((part) => part.trim())
      .find((part) => part.startsWith(`${PARTICIPANT_COOKIE}=`))?.slice(PARTICIPANT_COOKIE.length + 1);
    if (!value) return null;
    const match = /^(guest_[a-f0-9]{32}|\d{1,30})\.([a-f0-9]{64})$/.exec(value);
    if (!match || !timingSafeEqual(Buffer.from(match[2], 'hex'), Buffer.from(signature(match[1]), 'hex'))) return null;
    return match[1];
  }

  app.disable('x-powered-by');
  if (config.production) app.set('trust proxy', 1);
  app.use(helmet({
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https://cdn.discordapp.com'],
      connectSrc: ["'self'"], fontSrc: ["'self'"], objectSrc: ["'none'"],
      upgradeInsecureRequests: config.production ? [] : null,
    } },
    strictTransportSecurity: config.production,
  }));
  app.use(express.json({ limit: '4kb' }));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use(session({
    name: 'herbi.sid', secret: config.sessionSecret, store,
    resave: false, saveUninitialized: false, rolling: true,
    cookie: { httpOnly: true, secure: config.production, sameSite: 'lax', maxAge: 86_400_000 },
  }));
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Kurz durchatmen. Bitte in einer Minute erneut versuchen.' } }));
  app.use((req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('origin') !== config.appUrl) {
      return res.status(403).json({ error: 'Anfrage nicht erlaubt. Bitte die Seite neu laden.' });
    }
    req.participantId = readParticipant(req);
    // Keep existing participants recognized after upgrading from the login-based version.
    if (!req.participantId && /^\d{1,30}$/.test(req.session.user?.id || '')) {
      req.participantId = req.session.user.id;
      rememberParticipant(res, req.participantId);
    }
    for (const key of ['user', 'tokens', 'guildIds', 'oauth', 'twitch', 'twitchTokens', 'twitchOAuth']) delete req.session[key];
    next();
  });

  function currentRound() { return db.prepare('SELECT * FROM rounds ORDER BY id DESC LIMIT 1').get(); }
  function entriesFor(roundId) {
    return db.prepare(`SELECT e.participant_id AS id, e.display_name AS name, e.avatar, e.joined_at AS joinedAt
      FROM entries e WHERE e.round_id = ? AND e.eligible = 1 ORDER BY e.id`).all(roundId);
  }
  function notify() {
    for (const res of clients) res.write('event: change\ndata: {}\n\n');
  }
  function finalize() {
    const round = currentRound();
    if (round.status === 'drawing' && Date.now() >= round.started_at + round.duration_ms) {
      db.prepare("UPDATE rounds SET status = 'finished' WHERE id = ? AND status = 'drawing'").run(round.id);
      notify();
    }
  }
  function scheduleFinish() {
    clearTimeout(finishTimer);
    const round = currentRound();
    if (round.status === 'drawing') {
      finishTimer = setTimeout(finalize, Math.max(0, round.started_at + round.duration_ms - Date.now()) + 25);
      finishTimer.unref();
    }
  }
  function snapshot(req) {
    finalize();
    const round = currentRound();
    const entries = entriesFor(round.id);
    const myEntry = req.participantId && entries.find((entry) => entry.id === req.participantId);
    const lastEntry = req.participantId && db.prepare('SELECT display_name AS name, avatar FROM entries WHERE participant_id = ? ORDER BY id DESC LIMIT 1').get(req.participantId);
    return {
      serverTime: Date.now(),
      round: { id: round.id, status: round.status, createdAt: round.created_at, entries, total: entries.length,
        draw: round.started_at ? { startedAt: round.started_at, durationMs: round.duration_ms, rotation: round.rotation } : null,
        winner: round.status === 'finished' ? entries.find((entry) => entry.id === round.winner_id) : null,
      },
      me: lastEntry ? { id: req.participantId, ...lastEntry, entered: Boolean(myEntry),
        ticket: myEntry ? entries.findIndex((entry) => entry.id === myEntry.id) + 1 : null } : null,
      admin: Boolean(req.session.adminAt && Date.now() - req.session.adminAt < ADMIN_TTL),
    };
  }
  function requireAdmin(req, res, next) {
    if (!req.session.adminAt || Date.now() - req.session.adminAt >= ADMIN_TTL) {
      return res.status(401).json({ error: 'Bitte zuerst als Admin anmelden.' });
    }
    next();
  }

  app.get('/api/state', (req, res) => res.json(snapshot(req)));
  app.get('/api/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 3000\nevent: change\ndata: {}\n\n');
    clients.add(res);
    const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 20_000);
    req.on('close', () => { clients.delete(res); clearInterval(heartbeat); });
  });
  app.post('/api/participate', (req, res) => {
    const name = cleanName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Bitte einen Namen mit 2 bis 32 Zeichen eingeben.' });
    const round = currentRound();
    if (round.status !== 'open') return res.status(409).json({ error: 'Diese Runde ist geschlossen. Warte auf die nächste Runde.' });
    const ownEntry = req.participantId && db.prepare('SELECT id FROM entries WHERE round_id = ? AND participant_id = ?').get(round.id, req.participantId);
    if (ownEntry) return res.json(snapshot(req));
    if (entriesFor(round.id).some((entry) => nameKey(entry.name) === nameKey(name))) {
      return res.status(409).json({ error: 'Dieser Name ist in dieser Runde bereits dabei. Bitte wähle einen anderen Namen.' });
    }
    const id = req.participantId || `guest_${randomBytes(16).toString('hex')}`;
    db.prepare('INSERT INTO entries (round_id, participant_id, display_name, joined_at) VALUES (?, ?, ?, ?)')
      .run(round.id, id, name, Date.now());
    req.participantId = id;
    rememberParticipant(res, id);
    res.json(snapshot(req));
    notify();
  });
  // Existing bookmark/callback links return to the current participation form.
  app.use('/auth', (_req, res) => res.redirect('/'));
  const loginLimit = rateLimit({ windowMs: 15 * 60_000, limit: 8, skipSuccessfulRequests: true,
    standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Zu viele Versuche. Bitte in 15 Minuten erneut versuchen.' } });
  app.post('/api/admin/login', loginLimit, async (req, res) => {
    const password = req.body?.password;
    if (typeof password !== 'string' || password.length > 256 ||
        !timingSafeEqual(scryptSync(password, passwordSalt, 64), passwordHash)) {
      return res.status(401).json({ error: 'Das Passwort stimmt nicht.' });
    }
    await regenerate(req);
    req.session.adminAt = Date.now();
    await saveSession(req);
    res.json(snapshot(req));
  });
  app.post('/api/admin/logout', (req, res) => { delete req.session.adminAt; res.json(snapshot(req)); });
  app.post('/api/admin/draw', requireAdmin, (req, res) => {
    finalize();
    const round = currentRound();
    if (round.status !== 'open') return res.status(409).json({ error: 'Diese Runde wurde bereits gezogen.' });
    const entries = entriesFor(round.id);
    if (!entries.length) return res.status(409).json({ error: 'Es ist noch niemand im Lostopf.' });
    const winnerIndex = randomInt(entries.length);
    const rotation = 8 * 360 + (360 - (winnerIndex + 0.5) * 360 / entries.length);
    db.prepare("UPDATE rounds SET status = 'drawing', started_at = ?, duration_ms = ?, rotation = ?, winner_id = ? WHERE id = ? AND status = 'open'")
      .run(Date.now(), config.drawDurationMs || 10_000, rotation, entries[winnerIndex].id, round.id);
    scheduleFinish(); notify(); res.json(snapshot(req));
  });
  app.post('/api/admin/round', requireAdmin, (req, res) => {
    finalize();
    if (currentRound().status !== 'finished') return res.status(409).json({ error: 'Beende zuerst die aktuelle Ziehung.' });
    db.prepare('INSERT INTO rounds (created_at) VALUES (?)').run(Date.now());
    notify(); res.json(snapshot(req));
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Nicht gefunden.' }));
  app.use(express.static(fileURLToPath(new URL('../public/', import.meta.url)), { maxAge: 0, index: 'index.html' }));
  app.use((error, _req, res, _next) => {
    if (error.status >= 400 && error.status < 500) {
      return res.status(error.status).json({ error: error.type === 'entity.parse.failed' ? 'Ungültige Anfrage.' : error.message });
    }
    console.error('Request failed:', error.name);
    res.status(500).json({ error: 'Etwas ist schiefgelaufen. Bitte erneut versuchen.' });
  });
  finalize(); scheduleFinish();
  return { app, db, close() {
    clearTimeout(finishTimer);
    for (const client of clients) client.end();
    store.close(); db.close();
  } };
}
