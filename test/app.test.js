import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { GUILD_IDS, createDiscordClient } from '../server/discord.js';
import { createTwitchClient, TWITCH_SCOPE } from '../server/twitch.js';
import { DatabaseSync } from 'node:sqlite';

const baseConfig = {
  production: false, appUrl: 'http://localhost:3000',
  sessionSecret: 'a-session-secret-for-integration-tests-only-123456789',
  adminPassword: 'test-admin-password', clientId: '123456789', clientSecret: 'test-client-secret',
  callbackUrl: 'http://localhost:3000/auth/discord/callback', dataDir: ':memory:',
  twitchClientId: 'test-twitch-client', twitchClientSecret: 'test-twitch-secret',
  twitchCallbackUrl: 'http://localhost:3000/auth/twitch/callback',
  guildNames: ['Herbi Community', 'Partner Community'], guildInvites: ['', ''], drawDurationMs: 70,
};
function fixture(t, options = {}) {
  const allowed = new Map();
  const following = new Map();
  const discord = {
    exchange: async (code) => ({ access_token: code, refresh_token: `refresh-${code}`, expires_in: 3600 }),
    refresh: async (token) => ({ access_token: token.replace('refresh-', ''), refresh_token: token, expires_in: 3600 }),
    user: async (token) => ({ id: token, username: `user-${token}`, global_name: `Mitglied ${token}`, avatar: null }),
    guilds: async (token) => (allowed.get(token) || GUILD_IDS).map((id) => ({ id })),
    ...options.discord,
  };
  const twitch = {
    exchange: async (code) => ({ access_token: `twitch-token-${code}`, refresh_token: `twitch-refresh-${code}`, expires_in: 3600 }),
    refresh: async (token) => ({ access_token: token.replace('twitch-refresh-', 'twitch-token-'), refresh_token: token, expires_in: 3600 }),
    validate: async (token) => ({ client_id: baseConfig.twitchClientId, user_id: token.replace('twitch-token-', ''),
      login: `twitch-${token.replace('twitch-token-', '')}`, scopes: [TWITCH_SCOPE], expires_in: 3600 }),
    follows: async (_token, id) => following.get(id) ?? true,
    ...options.twitch,
  };
  const instance = createApp({ ...baseConfig, ...options.config }, { discord, twitch });
  t.after(() => instance.close());
  const agent = request.agent(instance.app);
  const post = (path, data, as = agent) => as.post(path).set('Origin', baseConfig.appUrl).send(data || {});
  async function loginDiscord(id = '123456789012345678', as = agent) {
    const start = await as.get('/auth/discord').expect(302);
    const state = new URL(start.headers.location).searchParams.get('state');
    return as.get('/auth/discord/callback').query({ state, code: id }).expect(302);
  }
  async function linkTwitch(id = '123456789012345678', as = agent) {
    const start = await as.get('/auth/twitch').expect(302);
    const state = new URL(start.headers.location).searchParams.get('state');
    return as.get('/auth/twitch/callback').query({ state, code: id }).expect(302);
  }
  async function login(id = '123456789012345678', as = agent) {
    const response = await loginDiscord(id, as);
    await linkTwitch(id, as);
    return response;
  }
  return { ...instance, agent, post, login, loginDiscord, linkTwitch, allowed, following, discord, twitch };
}

test('public page, health check and empty round work without exposing secrets', async (t) => {
  const { agent } = fixture(t);
  await agent.get('/').expect(200).expect('Content-Type', /html/);
  await agent.get('/app.js').expect(200);
  await agent.get('/health').expect(200, { ok: true });
  const { body, headers } = await agent.get('/api/state').expect(200);
  assert.equal(body.round.total, 0);
  assert.equal(body.round.status, 'open');
  assert.deepEqual(body.guilds.map((g) => g.id), GUILD_IDS);
  assert.equal(body.admin, false);
  assert.equal(body.me, null);
  assert.equal(headers['cache-control'], 'no-store');
  assert.doesNotMatch(JSON.stringify(body), /test-admin-password|test-client-secret|session-secret|test-twitch-secret/);
  assert.equal(body.twitch.channel, 'joedom');
  assert.match(headers['content-security-policy'], /script-src 'self'/);
});

test('OAuth requests only identify and guilds; unconfigured login returns setup message', async (t) => {
  const { agent } = fixture(t);
  const response = await agent.get('/auth/discord').expect(302);
  const url = new URL(response.headers.location);
  assert.equal(url.origin, 'https://discord.com');
  assert.equal(url.searchParams.get('scope'), 'identify guilds');
  assert.equal(url.searchParams.get('redirect_uri'), baseConfig.callbackUrl);
  assert.equal(url.searchParams.get('state').length, 64);
  const unconfigured = createApp({ ...baseConfig, clientId: '', clientSecret: '' });
  t.after(() => unconfigured.close());
  await request(unconfigured.app).get('/auth/discord').expect('Location', '/?error=setup');
});

test('OAuth rejects missing state, forged state and reused callbacks', async (t) => {
  const { agent } = fixture(t);
  await agent.get('/auth/discord/callback?code=123&state=forged').expect('Location', '/?error=state');
  const start = await agent.get('/auth/discord');
  const state = new URL(start.headers.location).searchParams.get('state');
  await agent.get('/auth/discord/callback').query({ state, code: '123456789012345678' }).expect('Location', '/?connected=discord');
  await agent.get('/auth/discord/callback').query({ state, code: '123456789012345678' }).expect('Location', '/?error=state');
  const { body } = await agent.get('/api/state');
  assert.equal(body.round.total, 0);
});

test('membership in only one server does not issue a ticket; checking again admits after joining both', async (t) => {
  const { agent, login, allowed, post } = fixture(t);
  const userId = '123456789012345678';
  allowed.set(userId, [GUILD_IDS[0]]);
  const callback = await login(userId);
  assert.equal(callback.headers.location, '/?error=membership');
  let response = await agent.get('/api/state');
  assert.equal(response.body.round.total, 0);
  assert.equal(response.body.me.entered, false);
  await post('/api/participate').expect(403);
  allowed.set(userId, GUILD_IDS);
  response = await post('/api/participate').expect(200);
  assert.equal(response.body.round.total, 1);
  assert.equal(response.body.me.entered, true);
  assert.equal(response.body.me.ticket, 1);
});

test('one Discord account gets exactly one ticket across repeated requests and browser sessions', async (t) => {
  const { agent, login, app, post } = fixture(t);
  await login();
  await Promise.all(Array.from({ length: 5 }, () => post('/api/participate').expect(200)));
  const other = request.agent(app);
  await login('123456789012345678', other);
  const { body } = await agent.get('/api/state');
  assert.equal(body.round.total, 1);
  assert.equal(body.me.ticket, 1);
});

test('membership is checked again rather than trusted from the previous login', async (t) => {
  const { login, allowed, post } = fixture(t);
  await login();
  allowed.set('123456789012345678', []);
  await post('/api/participate').expect(403);
});

test('sessions store OAuth tokens encrypted and API responses never contain them', async (t) => {
  const { login, db, agent } = fixture(t);
  await login();
  const sessions = db.prepare('SELECT payload FROM sessions').all();
  assert.ok(sessions.length > 0);
  for (const row of sessions) assert.doesNotMatch(row.payload, /refresh-|accessToken|Mitglied/);
  const response = await agent.get('/api/state');
  assert.doesNotMatch(JSON.stringify(response.body), /accessToken|refreshToken|refresh-|sessionSecret|twitch-token-|twitch-refresh-/);
});

test('expired Discord access tokens are refreshed before membership checks', async (t) => {
  let refreshed = 0;
  const { login, post } = fixture(t, { discord: {
    exchange: async (code) => ({ access_token: code, refresh_token: `refresh-${code}`, expires_in: -1 }),
    refresh: async (token) => { refreshed++; return { access_token: token.replace('refresh-', ''), refresh_token: token, expires_in: 3600 }; },
  } });
  await login();
  await post('/api/participate').expect(200);
  assert.equal(refreshed, 1);
});

test('Discord outage fails closed and gives a useful retry error', async (t) => {
  const { login, post, discord } = fixture(t);
  await login();
  discord.guilds = async () => { throw Object.assign(new Error('rate limited'), { status: 429 }); };
  const response = await post('/api/participate').expect(503);
  assert.match(response.body.error, /erneut versuchen/);
});

test('admin requires only the password and protects draw/new-round endpoints', async (t) => {
  const { post, agent } = fixture(t);
  await post('/api/admin/draw').expect(401);
  await post('/api/admin/round').expect(401);
  await post('/api/admin/login', { password: 'wrong' }).expect(401);
  const response = await post('/api/admin/login', { password: 'test-admin-password' }).expect(200);
  assert.equal(response.body.admin, true);
  await post('/api/admin/draw').expect(409);
  await post('/api/admin/logout').expect(200);
  assert.equal((await agent.get('/api/state')).body.admin, false);
});

test('mutations reject missing and cross-site Origin headers, even with a valid admin cookie', async (t) => {
  const { agent, post } = fixture(t);
  await post('/api/admin/login', { password: 'test-admin-password' }).expect(200);
  await agent.post('/api/admin/draw').send({}).expect(403);
  await agent.post('/api/admin/draw').set('Origin', 'https://evil.example').send({}).expect(403);
});

test('draw closes entries, selects a participant, maps to the correct wheel slice and permits a fresh round', async (t) => {
  const { agent, app, login, post, db } = fixture(t);
  await login();
  await login('223456789012345678', request.agent(app));
  await login('323456789012345678', request.agent(app));
  await post('/api/admin/login', { password: 'test-admin-password' }).expect(200);
  const drawing = (await post('/api/admin/draw').expect(200)).body.round;
  assert.equal(drawing.status, 'drawing');
  assert.equal(drawing.winner, null);
  await post('/api/participate').expect(409);
  await post('/api/admin/draw').expect(409);
  await post('/api/admin/round').expect(409);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const result = (await agent.get('/api/state')).body.round;
  assert.equal(result.status, 'finished');
  const winnerIndex = result.entries.findIndex((entry) => entry.id === result.winner.id);
  assert.ok(winnerIndex >= 0);
  const selectedAngle = ((360 - result.draw.rotation % 360) % 360);
  assert.equal(Math.floor(selectedAngle / (360 / result.total)), winnerIndex);
  const next = (await post('/api/admin/round').expect(200)).body;
  assert.equal(next.round.id, result.id + 1);
  assert.equal(next.round.total, 0);
  assert.equal(next.me.entered, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM entries WHERE round_id = ?').get(result.id).total, 3);
  await post('/api/participate').expect(200);
});

test('a slow membership check cannot enroll into a round that closed meanwhile', async (t) => {
  const { post, login, discord, agent } = fixture(t, { config: { drawDurationMs: 2000 } });
  await login();
  await post('/api/admin/login', { password: 'test-admin-password' });
  let finishCheck;
  let signalCheck;
  const startedCheck = new Promise((resolve) => { signalCheck = resolve; });
  discord.guilds = () => { signalCheck(); return new Promise((resolve) => { finishCheck = resolve; }); };
  const pending = post('/api/participate').then((response) => response);
  await startedCheck;
  await post('/api/admin/draw').expect(200);
  finishCheck(GUILD_IDS.map((id) => ({ id })));
  assert.equal((await pending).status, 409);
  assert.equal((await agent.get('/api/state')).body.round.total, 1);
});

test('logout removes login but preserves the ticket', async (t) => {
  const { login, post, agent } = fixture(t);
  await login();
  await post('/api/logout').expect(200);
  const response = await agent.get('/api/state');
  assert.equal(response.body.me, null);
  assert.equal(response.body.round.total, 1);
});

test('rounds, tickets and encrypted sessions survive a server restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'herbi-test-'));
  const config = { ...baseConfig, dataDir: directory };
  let instance = createApp(config);
  try {
    instance.db.prepare('INSERT INTO entries (round_id, discord_id, display_name, joined_at, twitch_id, twitch_verified_at) VALUES (1, ?, ?, ?, ?, ?)')
      .run('123456789012345678', 'Persistent user', Date.now(), '7654321', Date.now());
    const loginResponse = await request(instance.app).post('/api/admin/login').set('Origin', config.appUrl).send({ password: 'test-admin-password' });
    const cookie = loginResponse.headers['set-cookie'][0].split(';')[0];
    instance.db.prepare("UPDATE rounds SET status = 'drawing', started_at = ?, duration_ms = 10, rotation = 3060, winner_id = ? WHERE id = 1")
      .run(Date.now() - 1000, '123456789012345678');
    instance.close();
    instance = createApp(config);
    const { body } = await request(instance.app).get('/api/state').set('Cookie', cookie);
    assert.equal(body.round.total, 1);
    assert.equal(body.round.status, 'finished');
    assert.equal(body.round.winner.name, 'Persistent user');
    assert.equal(body.admin, true);
  } finally { instance.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Discord membership alone cannot issue a ticket; Twitch OAuth is required', async (t) => {
  const { agent, loginDiscord, post } = fixture(t);
  await loginDiscord();
  const { body } = await agent.get('/api/state');
  assert.equal(body.round.total, 0);
  assert.equal(body.me.twitch, null);
  await post('/api/participate').expect(401);
});

test('Twitch login requires Discord and uses only user:read:follows with a bound state', async (t) => {
  const { agent, loginDiscord } = fixture(t);
  await agent.get('/auth/twitch').expect('Location', '/?error=discord-first');
  await loginDiscord();
  const start = await agent.get('/auth/twitch').expect(302);
  const url = new URL(start.headers.location);
  assert.equal(url.origin, 'https://id.twitch.tv');
  assert.equal(url.searchParams.get('scope'), 'user:read:follows');
  assert.equal(url.searchParams.get('redirect_uri'), baseConfig.twitchCallbackUrl);
  assert.equal(url.searchParams.get('state').length, 64);
  await agent.get('/auth/twitch/callback?state=forged&code=12345').expect('Location', '/?error=state');
  await agent.get('/auth/twitch/callback').query({ state: url.searchParams.get('state'), code: '12345' }).expect('Location', '/?error=state');
});

test('non-followers are blocked; checking again after following issues exactly one ticket', async (t) => {
  const { agent, following, login, post } = fixture(t);
  following.set('123456789012345678', false);
  await login();
  const before = (await agent.get('/api/state')).body;
  assert.equal(before.round.total, 0);
  assert.equal(before.me.twitch.following, false);
  await post('/api/participate').expect(403);
  following.set('123456789012345678', true);
  const after = (await post('/api/participate').expect(200)).body;
  assert.equal(after.round.total, 1);
  assert.equal(after.me.twitch.following, true);
  await post('/api/participate').expect(200);
  assert.equal((await agent.get('/api/state')).body.round.total, 1);
});

test('one Twitch account cannot earn tickets for multiple Discord accounts', async (t) => {
  const { app, agent, login, loginDiscord, linkTwitch } = fixture(t);
  await login();
  const other = request.agent(app);
  await loginDiscord('223456789012345678', other);
  await linkTwitch('123456789012345678', other).then((response) => assert.equal(response.headers.location, '/?error=twitch-used'));
  assert.equal((await agent.get('/api/state')).body.round.total, 1);
  assert.equal((await other.get('/api/state')).body.me.entered, false);
});

test('switching Discord accounts drops the previous Twitch verification', async (t) => {
  const { agent, login, loginDiscord, post } = fixture(t);
  await login();
  await loginDiscord('223456789012345678');
  const { body } = await agent.get('/api/state');
  assert.equal(body.me.twitch, null);
  await post('/api/participate').expect(401);
  assert.equal(body.round.total, 1);
});

test('missing scope or a token for a different Twitch application fails verification', async (t) => {
  const { agent, loginDiscord, linkTwitch } = fixture(t, { twitch: {
    validate: async () => ({ client_id: 'other-client', user_id: '12345', login: 'viewer', scopes: [], expires_in: 3600 }),
  } });
  await loginDiscord();
  const response = await linkTwitch();
  assert.equal(response.headers.location, '/?error=twitch');
  assert.equal((await agent.get('/api/state')).body.round.total, 0);
});

test('expired Twitch tokens refresh and revoked tokens require reconnection', async (t) => {
  let refreshed = 0;
  const { agent, login, post, twitch } = fixture(t, { twitch: {
    exchange: async (code) => ({ access_token: `twitch-token-${code}`, refresh_token: `twitch-refresh-${code}`, expires_in: -1 }),
    refresh: async (token) => { refreshed++; return { access_token: token.replace('twitch-refresh-', 'twitch-token-'), refresh_token: token, expires_in: 3600 }; },
  } });
  await login();
  assert.equal(refreshed, 1);
  twitch.validate = async () => { throw Object.assign(new Error('Revoked'), { status: 401 }); };
  await post('/api/participate').expect(401);
  assert.equal((await agent.get('/api/state')).body.me.twitch, null);
});

test('Twitch outage never issues a ticket and follows are rechecked in a new round', async (t) => {
  const { agent, login, post, twitch, following } = fixture(t);
  await login();
  await post('/api/admin/login', { password: baseConfig.adminPassword });
  await post('/api/admin/draw').expect(200);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await post('/api/admin/round').expect(200);
  following.set('123456789012345678', false);
  await post('/api/participate').expect(403);
  twitch.follows = async () => { throw Object.assign(new Error('Rate limited'), { status: 429 }); };
  await post('/api/participate').expect(503);
  assert.equal((await agent.get('/api/state')).body.round.total, 0);
});

test('an existing ticket keeps its Twitch binding when another account is connected', async (t) => {
  const { login, linkTwitch, db } = fixture(t);
  await login();
  const response = await linkTwitch('223456789012345678');
  assert.equal(response.headers.location, '/?error=twitch-locked');
  assert.equal(db.prepare('SELECT twitch_id FROM entries LIMIT 1').get().twitch_id, '123456789012345678');
});

test('Twitch HTTP client resolves joedom and checks the authenticated user against that channel only', async () => {
  const calls = [];
  const client = createTwitchClient(baseConfig, async (url, options) => {
    calls.push({ url, options });
    const result = url.includes('/users?') ? { data: [{ id: 'joedom-id', login: 'joedom' }] }
      : url.includes('/channels/followed?') ? { data: [{ broadcaster_id: 'joedom-id' }] } : {};
    return { ok: true, json: async () => result };
  });
  await client.exchange('auth-code');
  assert.equal(calls[0].options.body.get('redirect_uri'), baseConfig.twitchCallbackUrl);
  assert.equal(calls[0].options.body.get('grant_type'), 'authorization_code');
  assert.equal(await client.follows('token', 'viewer-id'), true);
  const params = new URL(calls[2].url).searchParams;
  assert.equal(params.get('broadcaster_id'), 'joedom-id');
  assert.equal(params.get('user_id'), 'viewer-id');
  assert.equal(calls[2].options.headers['Client-Id'], baseConfig.twitchClientId);
  assert.equal(calls[2].options.headers.Authorization, 'Bearer token');
  await client.validate('token');
  assert.equal(calls[3].options.headers.Authorization, 'OAuth token');
});

test('migration requires Twitch re-verification for open entries and preserves historic results', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'herbi-migration-'));
  const legacy = new DatabaseSync(join(directory, 'giveaway.sqlite'));
  legacy.exec(`CREATE TABLE rounds (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL, started_at INTEGER, duration_ms INTEGER, rotation REAL, winner_id TEXT);
    CREATE TABLE entries (id INTEGER PRIMARY KEY AUTOINCREMENT, round_id INTEGER NOT NULL, discord_id TEXT NOT NULL,
    display_name TEXT NOT NULL, avatar TEXT, joined_at INTEGER NOT NULL, UNIQUE(round_id, discord_id));
    INSERT INTO rounds (id, status, created_at, winner_id) VALUES (1, 'finished', 1, '111'), (2, 'open', 2, NULL);
    INSERT INTO entries (round_id, discord_id, display_name, joined_at) VALUES (1, '111', 'Old winner', 1), (2, '222', 'Not yet verified', 2);`);
  legacy.close();
  const instance = createApp({ ...baseConfig, dataDir: directory });
  try {
    const { body } = await request(instance.app).get('/api/state');
    assert.equal(body.round.total, 0);
    assert.equal(instance.db.prepare('SELECT requires_twitch FROM rounds WHERE id = 1').get().requires_twitch, 0);
    assert.equal(instance.db.prepare('SELECT requires_twitch FROM rounds WHERE id = 2').get().requires_twitch, 1);
    assert.equal(instance.db.prepare('SELECT COUNT(*) AS total FROM entries').get().total, 2);
  } finally { instance.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('startup audit clears a revoked Twitch connection from a persisted encrypted session', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'herbi-twitch-audit-'));
  const config = { ...baseConfig, dataDir: directory };
  const discord = {
    exchange: async () => ({ access_token: 'discord-token', refresh_token: 'discord-refresh', expires_in: 3600 }),
    user: async () => ({ id: '123456789012345678', username: 'viewer' }),
    guilds: async () => GUILD_IDS.map((id) => ({ id })),
  };
  const twitch = {
    exchange: async () => ({ access_token: 'twitch-token', refresh_token: 'twitch-refresh', expires_in: 3600 }),
    validate: async () => ({ user_id: '9999', client_id: config.twitchClientId, login: 'viewer', scopes: [TWITCH_SCOPE], expires_in: 3600 }),
    follows: async () => true,
  };
  let instance = createApp(config, { discord, twitch });
  try {
    const agent = request.agent(instance.app);
    const startDiscord = await agent.get('/auth/discord');
    const discordState = new URL(startDiscord.headers.location).searchParams.get('state');
    await agent.get('/auth/discord/callback').query({ state: discordState, code: '123' });
    const startTwitch = await agent.get('/auth/twitch');
    const twitchState = new URL(startTwitch.headers.location).searchParams.get('state');
    const response = await agent.get('/auth/twitch/callback').query({ state: twitchState, code: '456' });
    const cookie = response.headers['set-cookie'][0].split(';')[0];
    instance.close();
    let auditCalls = 0;
    twitch.validate = async () => { auditCalls++; throw Object.assign(new Error('Revoked'), { status: 401 }); };
    instance = createApp(config, { discord, twitch });
    await new Promise((resolve) => setImmediate(resolve));
    const { body } = await request(instance.app).get('/api/state').set('Cookie', cookie);
    assert.equal(auditCalls, 1);
    assert.equal(body.me.twitch, null);
    assert.equal(body.me.id, '123456789012345678');
  } finally { instance.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Discord HTTP client exchanges form-encoded tokens and uses Bearer authentication', async () => {
  const calls = [];
  const client = createDiscordClient(baseConfig, async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ access_token: 'secret-token' }) };
  });
  await client.exchange('authorization-code');
  await client.guilds('secret-token');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(calls[0].options.body.get('redirect_uri'), baseConfig.callbackUrl);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer secret-token');
  assert.match(calls[1].url, /\/users\/@me\/guilds\?limit=200$/);
});
