import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDatabase, SQLiteSessionStore } from './database.js';
import { createDiscordClient, GUILD_IDS, publicUser } from './discord.js';

const saveSession = (req) => new Promise((resolve, reject) => req.session.save((e) => e ? reject(e) : resolve()));
const regenerate = (req) => new Promise((resolve, reject) => req.session.regenerate((e) => e ? reject(e) : resolve()));
const ADMIN_TTL = 4 * 60 * 60 * 1000;

export function createApp(config, overrides = {}) {
  const app = express();
  const db = overrides.db || openDatabase(config.dataDir);
  const discord = overrides.discord || createDiscordClient(config);
  const store = new SQLiteSessionStore(db, config.sessionSecret);
  const clients = new Set();
  let finishTimer;
  const passwordSalt = randomBytes(16);
  const passwordHash = scryptSync(config.adminPassword, passwordSalt, 64);
  const guilds = GUILD_IDS.map((id, index) => ({
    id, name: config.guildNames[index],
    url: /^https:\/\/(discord\.gg\/|discord\.com\/invite\/)[a-zA-Z0-9-]+$/.test(config.guildInvites[index] || '')
      ? config.guildInvites[index] : `https://discord.com/channels/${id}`,
    hasInvite: Boolean(config.guildInvites[index]),
  }));

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
  app.use(['/api', '/auth'], (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Kurz durchatmen. Bitte in einer Minute erneut versuchen.' } }));
  app.use((req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('origin') !== config.appUrl) {
      return res.status(403).json({ error: 'Anfrage nicht erlaubt. Bitte die Seite neu laden.' });
    }
    next();
  });

  function currentRound() {
    return db.prepare('SELECT * FROM rounds ORDER BY id DESC LIMIT 1').get();
  }
  function entriesFor(roundId) {
    return db.prepare('SELECT discord_id AS id, display_name AS name, avatar, joined_at AS joinedAt FROM entries WHERE round_id = ? ORDER BY id').all(roundId);
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
    const myEntry = req.session.user && entries.find((entry) => entry.id === req.session.user.id);
    return {
      serverTime: Date.now(), configured: Boolean(config.clientId && config.clientSecret),
      guilds,
      round: { id: round.id, status: round.status, createdAt: round.created_at,
        entries, total: entries.length,
        draw: round.started_at ? { startedAt: round.started_at, durationMs: round.duration_ms, rotation: round.rotation } : null,
        winner: round.status === 'finished' ? entries.find((entry) => entry.id === round.winner_id) : null,
      },
      me: req.session.user ? { ...req.session.user,
        guildIds: req.session.guildIds || [], entered: Boolean(myEntry),
        ticket: myEntry ? entries.findIndex((entry) => entry.id === myEntry.id) + 1 : null,
      } : null,
      admin: Boolean(req.session.adminAt && Date.now() - req.session.adminAt < ADMIN_TTL),
    };
  }
  async function checkMembership(req) {
    let tokens = req.session.tokens;
    if (!tokens) throw Object.assign(new Error('Bitte erneut mit Discord anmelden.'), { status: 401 });
    if (tokens.expiresAt < Date.now() + 30_000) {
      try {
        const refreshed = await discord.refresh(tokens.refreshToken);
        tokens = req.session.tokens = {
          accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token,
          expiresAt: Date.now() + refreshed.expires_in * 1000,
        };
      } catch (error) {
        if ([400, 401, 403].includes(error.status)) {
          delete req.session.tokens;
          throw Object.assign(new Error('Deine Discord-Anmeldung ist abgelaufen. Bitte erneut anmelden.'), { status: 401 });
        }
        throw Object.assign(new Error('Discord ist gerade nicht erreichbar. Bitte erneut versuchen.'), { status: 503 });
      }
    }
    let memberships;
    try { memberships = await discord.guilds(tokens.accessToken); }
    catch (error) {
      throw Object.assign(new Error([401, 403].includes(error.status)
        ? 'Bitte erneut mit Discord anmelden.' : 'Discord ist gerade nicht erreichbar. Bitte erneut versuchen.'),
      { status: [401, 403].includes(error.status) ? 401 : 503 });
    }
    req.session.guildIds = memberships.filter((guild) => GUILD_IDS.includes(guild.id)).map((guild) => guild.id);
    return GUILD_IDS.every((id) => req.session.guildIds.includes(id));
  }
  function enter(req, expectedRoundId) {
    const round = currentRound();
    if (round.status !== 'open' || round.id !== expectedRoundId) {
      throw Object.assign(new Error('Die Runde wurde bereits geschlossen. Warte auf die nächste Runde.'), { status: 409 });
    }
    const user = req.session.user;
    const result = db.prepare('INSERT OR IGNORE INTO entries (round_id, discord_id, display_name, avatar, joined_at) VALUES (?, ?, ?, ?, ?)')
      .run(round.id, user.id, user.name, user.avatar, Date.now());
    if (result.changes) notify();
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

  const authLimit = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (_req, res) => res.redirect('/?error=auth-rate') });
  app.get('/auth/discord', authLimit, async (req, res) => {
    if (!config.clientId || !config.clientSecret) return res.redirect('/?error=setup');
    req.session.oauth = { state: randomBytes(32).toString('hex'), createdAt: Date.now() };
    await saveSession(req);
    const params = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.callbackUrl,
      response_type: 'code', scope: 'identify guilds', state: req.session.oauth.state });
    res.redirect(`https://discord.com/oauth2/authorize?${params}`);
  });
  app.get('/auth/discord/callback', authLimit, async (req, res) => {
    const pending = req.session.oauth;
    delete req.session.oauth;
    await saveSession(req);
    if (!pending || typeof req.query.state !== 'string' || req.query.state !== pending.state || Date.now() - pending.createdAt > 600_000) {
      return res.redirect('/?error=state');
    }
    if (req.query.error) return res.redirect('/?error=cancelled');
    if (typeof req.query.code !== 'string') return res.redirect('/?error=discord');
    try {
      const tokens = await discord.exchange(req.query.code);
      const profile = publicUser(await discord.user(tokens.access_token));
      const adminAt = req.session.adminAt;
      await regenerate(req);
      req.session.user = profile;
      req.session.adminAt = adminAt;
      req.session.tokens = { accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + tokens.expires_in * 1000 };
      const roundId = currentRound().id;
      const eligible = await checkMembership(req);
      if (eligible && currentRound().status === 'open' && currentRound().id === roundId) enter(req, roundId);
      await saveSession(req);
      res.redirect(eligible ? '/?joined=1' : '/?error=membership');
    } catch { res.redirect('/?error=discord'); }
  });
  app.post('/api/participate', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Bitte zuerst mit Discord anmelden.' });
    const roundId = currentRound().id;
    if (!await checkMembership(req)) {
      await saveSession(req);
      return res.status(403).json({ error: 'Du musst Mitglied in beiden Discord-Servern sein.' });
    }
    enter(req, roundId);
    await saveSession(req);
    res.json(snapshot(req));
  });
  app.post('/api/logout', async (req, res, next) => {
    req.session.destroy((error) => {
      if (error) return next(error);
      res.clearCookie('herbi.sid', { httpOnly: true, secure: config.production, sameSite: 'lax' });
      res.json({ ok: true });
    });
  });
  const loginLimit = rateLimit({ windowMs: 15 * 60_000, limit: 8, skipSuccessfulRequests: true,
    standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Zu viele Versuche. Bitte in 15 Minuten erneut versuchen.' } });
  app.post('/api/admin/login', loginLimit, async (req, res) => {
    const password = req.body?.password;
    if (typeof password !== 'string' || password.length > 256 ||
        !timingSafeEqual(scryptSync(password, passwordSalt, 64), passwordHash)) {
      return res.status(401).json({ error: 'Das Passwort stimmt nicht.' });
    }
    const { user, tokens, guildIds } = req.session;
    await regenerate(req);
    Object.assign(req.session, { user, tokens, guildIds, adminAt: Date.now() });
    await saveSession(req);
    res.json(snapshot(req));
  });
  app.post('/api/admin/logout', (req, res) => {
    delete req.session.adminAt;
    res.json(snapshot(req));
  });
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
    scheduleFinish();
    notify();
    res.json(snapshot(req));
  });
  app.post('/api/admin/round', requireAdmin, (req, res) => {
    finalize();
    if (currentRound().status !== 'finished') return res.status(409).json({ error: 'Beende zuerst die aktuelle Ziehung.' });
    db.prepare('INSERT INTO rounds (created_at) VALUES (?)').run(Date.now());
    notify();
    res.json(snapshot(req));
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Nicht gefunden.' }));
  const publicPath = fileURLToPath(new URL('../public/', import.meta.url));
  app.use(express.static(publicPath, { maxAge: config.production ? '1h' : 0, index: 'index.html' }));
  app.use((error, _req, res, _next) => {
    if (error.status >= 400 && error.status < 500) {
      return res.status(error.status).json({ error: error.type === 'entity.parse.failed' ? 'Ungültige Anfrage.' : error.message });
    }
    if (error.status === 503) return res.status(503).json({ error: error.message });
    console.error('Request failed:', error.name);
    res.status(500).json({ error: 'Etwas ist schiefgelaufen. Bitte erneut versuchen.' });
  });
  finalize();
  scheduleFinish();
  return { app, db, close() {
    clearTimeout(finishTimer);
    for (const client of clients) client.end();
    store.close();
    db.close();
  } };
}
