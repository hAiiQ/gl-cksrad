import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDatabase, SQLiteSessionStore } from './database.js';
import { createDiscordClient, GUILD_IDS, publicUser } from './discord.js';
import { createTwitchClient, TWITCH_CHANNEL, TWITCH_SCOPE } from './twitch.js';

const saveSession = (req) => new Promise((resolve, reject) => req.session.save((e) => e ? reject(e) : resolve()));
const regenerate = (req) => new Promise((resolve, reject) => req.session.regenerate((e) => e ? reject(e) : resolve()));
const ADMIN_TTL = 4 * 60 * 60 * 1000;

export function createApp(config, overrides = {}) {
  const app = express();
  const db = overrides.db || openDatabase(config.dataDir);
  const discord = overrides.discord || createDiscordClient(config);
  const twitch = overrides.twitch || createTwitchClient(config);
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
    return db.prepare(`SELECT e.discord_id AS id, e.display_name AS name, e.avatar, e.joined_at AS joinedAt
      FROM entries e JOIN rounds r ON r.id = e.round_id
      WHERE r.id = ? AND (r.requires_twitch = 0 OR (e.twitch_id IS NOT NULL AND e.twitch_verified_at IS NOT NULL))
      ORDER BY e.id`).all(roundId);
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
      twitch: { configured: Boolean(config.twitchClientId && config.twitchClientSecret),
        channel: TWITCH_CHANNEL, url: `https://www.twitch.tv/${TWITCH_CHANNEL}` },
      round: { id: round.id, status: round.status, createdAt: round.created_at,
        entries, total: entries.length,
        draw: round.started_at ? { startedAt: round.started_at, durationMs: round.duration_ms, rotation: round.rotation } : null,
        winner: round.status === 'finished' ? entries.find((entry) => entry.id === round.winner_id) : null,
      },
      me: req.session.user ? { ...req.session.user,
        guildIds: req.session.guildIds || [], entered: Boolean(myEntry),
        twitch: req.session.twitch && req.session.twitchTokens ? {
          name: req.session.twitch.name, following: req.session.twitch.following,
          checkedAt: req.session.twitch.checkedAt || null,
        } : null,
        ticket: myEntry ? entries.findIndex((entry) => entry.id === myEntry.id) + 1 : null,
      } : null,
      admin: Boolean(req.session.adminAt && Date.now() - req.session.adminAt < ADMIN_TTL),
    };
  }
  async function validateTwitch(value, force = false) {
    let tokens = value.twitchTokens;
    if (!tokens) throw Object.assign(new Error('Bitte dein Twitch-Konto verbinden.'), { status: 401 });
    try {
      if (tokens.expiresAt < Date.now() + 30_000) {
        const refreshed = await twitch.refresh(tokens.refreshToken);
        tokens = value.twitchTokens = { accessToken: refreshed.access_token,
          refreshToken: refreshed.refresh_token, expiresAt: Date.now() + refreshed.expires_in * 1000 };
        force = true;
      }
      if (force || !tokens.validatedAt || Date.now() - tokens.validatedAt >= 3_600_000) {
        const identity = await twitch.validate(tokens.accessToken);
        if (identity.client_id !== config.twitchClientId || !Array.isArray(identity.scopes) || !identity.scopes.includes(TWITCH_SCOPE) ||
            !/^\d+$/.test(identity.user_id) || (value.twitch && value.twitch.id !== identity.user_id)) {
          throw Object.assign(new Error('Ungültige Twitch-Anmeldung.'), { status: 401 });
        }
        tokens.validatedAt = Date.now();
        tokens.expiresAt = Date.now() + identity.expires_in * 1000;
        value.twitch = { ...value.twitch, id: identity.user_id, name: identity.login, following: value.twitch?.following || false };
      }
    } catch (error) {
      if ([400, 401, 403].includes(error.status)) {
        delete value.twitch;
        delete value.twitchTokens;
        throw Object.assign(new Error('Bitte dein Twitch-Konto erneut verbinden.'), { status: 401 });
      }
      throw Object.assign(new Error('Twitch ist gerade nicht erreichbar. Bitte erneut versuchen.'), { status: 503 });
    }
    return tokens;
  }
  async function checkTwitch(req) {
    if (!config.twitchClientId || !config.twitchClientSecret) {
      throw Object.assign(new Error('Die Twitch-Verifizierung wird noch eingerichtet.'), { status: 503 });
    }
    const tokens = await validateTwitch(req.session, true);
    req.session.twitch.following = false;
    req.session.twitch.checkedAt = null;
    try {
      const following = await twitch.follows(tokens.accessToken, req.session.twitch.id);
      req.session.twitch.following = following;
      req.session.twitch.checkedAt = Date.now();
      return following;
    } catch (error) {
      if ([401, 403].includes(error.status)) {
        delete req.session.twitch;
        delete req.session.twitchTokens;
        throw Object.assign(new Error('Bitte dein Twitch-Konto erneut verbinden.'), { status: 401 });
      }
      throw Object.assign(new Error('Twitch ist gerade nicht erreichbar. Bitte erneut versuchen.'), { status: 503 });
    }
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
    const verified = req.session.twitch;
    if (!verified?.following || !verified.checkedAt || Date.now() - verified.checkedAt > 60_000) {
      throw Object.assign(new Error('Bitte zuerst den Twitch-Follow bestätigen.'), { status: 403 });
    }
    const ownEntry = db.prepare('SELECT twitch_id FROM entries WHERE round_id = ? AND discord_id = ?').get(round.id, user.id);
    if (ownEntry?.twitch_id && ownEntry.twitch_id !== verified.id) {
      throw Object.assign(new Error('Dein Los ist für diese Runde bereits mit einem anderen Twitch-Konto verknüpft.'), { status: 409, code: 'twitch-locked' });
    }
    const used = db.prepare('SELECT discord_id FROM entries WHERE round_id = ? AND twitch_id = ?').get(round.id, verified.id);
    if (used && used.discord_id !== user.id) {
      throw Object.assign(new Error('Dieses Twitch-Konto hat in dieser Runde bereits ein Los.'), { status: 409, code: 'twitch-used' });
    }
    const result = db.prepare(`INSERT INTO entries
      (round_id, discord_id, display_name, avatar, joined_at, twitch_id, twitch_name, twitch_verified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(round_id, discord_id) DO UPDATE SET
      twitch_id = excluded.twitch_id, twitch_name = excluded.twitch_name, twitch_verified_at = excluded.twitch_verified_at`)
      .run(round.id, user.id, user.name, user.avatar, Date.now(), verified.id, verified.name, verified.checkedAt);
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

  const authLimit = rateLimit({ windowMs: 15 * 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false,
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
      const keepTwitch = req.session.user?.id === profile.id
        ? { twitch: req.session.twitch, twitchTokens: req.session.twitchTokens } : {};
      await regenerate(req);
      req.session.user = profile;
      req.session.adminAt = adminAt;
      Object.assign(req.session, keepTwitch);
      req.session.tokens = { accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + tokens.expires_in * 1000 };
      const eligible = await checkMembership(req);
      await saveSession(req);
      res.redirect(eligible ? '/?connected=discord' : '/?error=membership');
    } catch { res.redirect('/?error=discord'); }
  });

  app.get('/auth/twitch', authLimit, async (req, res) => {
    if (!req.session.user) return res.redirect('/?error=discord-first');
    if (!config.twitchClientId || !config.twitchClientSecret) return res.redirect('/?error=twitch-setup');
    req.session.twitchOAuth = { state: randomBytes(32).toString('hex'), createdAt: Date.now(), discordId: req.session.user.id };
    await saveSession(req);
    const params = new URLSearchParams({ client_id: config.twitchClientId, redirect_uri: config.twitchCallbackUrl,
      response_type: 'code', scope: TWITCH_SCOPE, state: req.session.twitchOAuth.state, force_verify: 'true' });
    res.redirect(`https://id.twitch.tv/oauth2/authorize?${params}`);
  });
  app.get('/auth/twitch/callback', authLimit, async (req, res) => {
    const pending = req.session.twitchOAuth;
    delete req.session.twitchOAuth;
    await saveSession(req);
    if (!pending || !req.session.user || pending.discordId !== req.session.user.id ||
        typeof req.query.state !== 'string' || req.query.state !== pending.state || Date.now() - pending.createdAt > 600_000) {
      return res.redirect('/?error=state');
    }
    if (req.query.error) return res.redirect('/?error=twitch-cancelled');
    if (typeof req.query.code !== 'string') return res.redirect('/?error=twitch');
    try {
      const roundId = currentRound().id;
      const tokens = await twitch.exchange(req.query.code);
      const staged = { twitchTokens: { accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + tokens.expires_in * 1000 } };
      await validateTwitch(staged, true);
      const { user, tokens: discordTokens, guildIds, adminAt } = req.session;
      await regenerate(req);
      Object.assign(req.session, { user, tokens: discordTokens, guildIds, adminAt, ...staged });
      const following = await checkTwitch(req);
      const eligible = await checkMembership(req);
      if (following && eligible && currentRound().status === 'open' && currentRound().id === roundId) enter(req, roundId);
      await saveSession(req);
      res.redirect(!following ? '/?error=twitch-follow' : !eligible ? '/?error=membership' : '/?connected=twitch');
    } catch (error) {
      res.redirect(`/?error=${['twitch-used', 'twitch-locked'].includes(error.code) ? error.code : 'twitch'}`);
    }
  });
  app.post('/api/participate', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Bitte zuerst mit Discord anmelden.' });
    const roundId = currentRound().id;
    if (!await checkMembership(req)) {
      await saveSession(req);
      return res.status(403).json({ error: 'Du musst Mitglied in beiden Discord-Servern sein.' });
    }
    if (!await checkTwitch(req)) {
      await saveSession(req);
      return res.status(403).json({ error: `Folge zuerst ${TWITCH_CHANNEL} auf Twitch und prüfe den Follow erneut.` });
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
    const { user, tokens, guildIds, twitch: twitchProfile, twitchTokens } = req.session;
    await regenerate(req);
    Object.assign(req.session, { user, tokens, guildIds, twitch: twitchProfile, twitchTokens, adminAt: Date.now() });
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
    db.prepare('INSERT INTO rounds (created_at, requires_twitch) VALUES (?, 1)').run(Date.now());
    notify();
    res.json(snapshot(req));
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Nicht gefunden.' }));
  const publicPath = fileURLToPath(new URL('../public/', import.meta.url));
  app.use(express.static(publicPath, { maxAge: 0, index: 'index.html' }));
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
  // Twitch requires token validation at startup and at least hourly.
  let auditRunning = false;
  async function auditTwitchSessions() {
    if (auditRunning || !config.twitchClientId || !config.twitchClientSecret) return;
    auditRunning = true;
    try {
      await store.auditSessions(async (value) => {
        try { await validateTwitch(value, true); } catch { /* Invalid tokens are removed; outages are retried. */ }
      });
    } finally { auditRunning = false; }
  }
  const twitchAudit = setInterval(() => { auditTwitchSessions().catch(() => {}); }, 3_600_000);
  twitchAudit.unref();
  auditTwitchSessions().catch(() => {});
  return { app, db, close() {
    clearTimeout(finishTimer);
    clearInterval(twitchAudit);
    for (const client of clients) client.end();
    store.close();
    db.close();
  } };
}
