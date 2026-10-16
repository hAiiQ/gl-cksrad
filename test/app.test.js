import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { GUILD_IDS, createDiscordClient } from '../server/discord.js';

const baseConfig = {
  production: false, appUrl: 'http://localhost:3000',
  sessionSecret: 'a-session-secret-for-integration-tests-only-123456789',
  adminPassword: 'test-admin-password', clientId: '123456789', clientSecret: 'test-client-secret',
  callbackUrl: 'http://localhost:3000/auth/discord/callback', dataDir: ':memory:',
  guildNames: ['Herbi Community', 'Partner Community'], guildInvites: ['', ''], drawDurationMs: 70,
};
function fixture(t, options = {}) {
  const allowed = new Map();
  const discord = {
    exchange: async (code) => ({ access_token: code, refresh_token: `refresh-${code}`, expires_in: 3600 }),
    refresh: async (token) => ({ access_token: token.replace('refresh-', ''), refresh_token: token, expires_in: 3600 }),
    user: async (token) => ({ id: token, username: `user-${token}`, global_name: `Mitglied ${token}`, avatar: null }),
    guilds: async (token) => (allowed.get(token) || GUILD_IDS).map((id) => ({ id })),
    ...options.discord,
  };
  const instance = createApp({ ...baseConfig, ...options.config }, { discord });
  t.after(() => instance.close());
  const agent = request.agent(instance.app);
  const post = (path, data, as = agent) => as.post(path).set('Origin', baseConfig.appUrl).send(data || {});
  async function login(id = '123456789012345678', as = agent) {
    const start = await as.get('/auth/discord').expect(302);
    const state = new URL(start.headers.location).searchParams.get('state');
    return as.get('/auth/discord/callback').query({ state, code: id }).expect(302);
  }
  return { ...instance, agent, post, login, allowed, discord };
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
  assert.doesNotMatch(JSON.stringify(body), /test-admin-password|test-client-secret|session-secret/);
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
  await agent.get('/auth/discord/callback').query({ state, code: '123456789012345678' }).expect('Location', '/?joined=1');
  await agent.get('/auth/discord/callback').query({ state, code: '123456789012345678' }).expect('Location', '/?error=state');
  const { body } = await agent.get('/api/state');
  assert.equal(body.round.total, 1);
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
  assert.doesNotMatch(JSON.stringify(response.body), /accessToken|refreshToken|refresh-|sessionSecret/);
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
    instance.db.prepare('INSERT INTO entries (round_id, discord_id, display_name, joined_at) VALUES (1, ?, ?, ?)')
      .run('123456789012345678', 'Persistent user', Date.now());
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
