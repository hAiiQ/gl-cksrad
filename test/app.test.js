import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { openDatabase, SQLiteSessionStore } from '../server/database.js';

const config = {
  production: false, appUrl: 'http://localhost:3000',
  sessionSecret: 'a-session-secret-for-integration-tests-only-123456789',
  adminPassword: 'test-admin-password', dataDir: ':memory:', drawDurationMs: 70,
};
function fixture(t, overrides = {}) {
  const instance = createApp({ ...config, ...overrides });
  t.after(() => instance.close());
  const agent = request.agent(instance.app);
  const post = (path, data, as = agent) => as.post(path).set('Origin', config.appUrl).send(data || {});
  const enter = (name = 'Nova', as = agent) => post('/api/participate', { name }, as);
  const admin = () => post('/api/admin/login', { password: config.adminPassword }).expect(200);
  return { ...instance, agent, post, enter, admin };
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('page and empty round work without external credentials or accounts', async (t) => {
  const { agent } = fixture(t);
  const page = await agent.get('/').expect(200);
  assert.match(page.text, /id="participant-name"/);
  assert.doesNotMatch(page.text, /discord|twitch|client.?id|verifizier/i);
  await agent.get('/app.js').expect(200);
  await agent.get('/health').expect(200, { ok: true });
  const { body, headers } = await agent.get('/api/state').expect(200);
  assert.equal(body.round.total, 0);
  assert.equal(body.round.status, 'open');
  assert.equal(body.me, null);
  assert.equal(body.admin, false);
  assert.equal(headers['cache-control'], 'no-store');
  assert.doesNotMatch(JSON.stringify(body), /test-admin-password|session-secret/);
});

test('a name creates one ticket and a persistent, signed browser cookie', async (t) => {
  const { enter, agent } = fixture(t);
  const { body, headers } = await enter('  Nova  ').expect(200);
  assert.equal(body.round.total, 1);
  assert.equal(body.me.name, 'Nova');
  assert.equal(body.me.entered, true);
  assert.equal(body.me.ticket, 1);
  assert.match(body.me.id, /^guest_[a-f0-9]{32}$/);
  const cookie = headers['set-cookie'].find((value) => value.startsWith('herbi.participant='));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=31536000/);
  assert.equal((await agent.get('/api/state')).body.me.ticket, 1);
});

test('refreshes, repeated submissions and different names cannot create a second ticket in the same browser', async (t) => {
  const { enter, agent } = fixture(t);
  const original = (await enter('Nova')).body;
  await Promise.all(Array.from({ length: 5 }, (_, index) => enter(`Other ${index}`).expect(200)));
  const { body } = await agent.get('/api/state');
  assert.equal(body.round.total, 1);
  assert.equal(body.me.name, 'Nova');
  assert.equal(body.me.id, original.me.id);
});

test('different browsers participate and ticket numbers remain stable as people join', async (t) => {
  const { app, agent, enter } = fixture(t);
  await enter('Nova');
  await enter('Luna', request.agent(app)).expect(200);
  await enter('Pixel', request.agent(app)).expect(200);
  const { body } = await agent.get('/api/state');
  assert.deepEqual(body.round.entries.map((entry) => entry.name), ['Nova', 'Luna', 'Pixel']);
  assert.equal(body.me.ticket, 1);
});

test('duplicate names are rejected across case, whitespace and compatibility Unicode forms', async (t) => {
  const { app, enter } = fixture(t);
  await enter('JÖE Dom').expect(200);
  for (const name of ['jöe dom', '  JÖE   DOM ', 'ＪÖＥ Dom']) {
    const result = await enter(name, request.agent(app)).expect(409);
    assert.match(result.body.error, /Name.*bereits/);
  }
});

test('invalid, oversized, invisible and non-string names are rejected', async (t) => {
  const { post, agent } = fixture(t);
  for (const name of ['', ' ', 'a', 'x'.repeat(33), 'a\u0000b', 'a\u200bb', null, 123, {}, []]) {
    await post('/api/participate', { name }).expect(400);
  }
  assert.equal((await agent.get('/api/state')).body.round.total, 0);
});

test('names containing HTML are stored as text and cannot alter the served page', async (t) => {
  const { enter, agent } = fixture(t);
  const name = '<b>Nova</b>';
  const response = await enter(name).expect(200);
  assert.equal(response.body.me.name, name);
  const html = await agent.get('/');
  assert.doesNotMatch(html.text, /<b>Nova<\/b>/);
  assert.match(html.headers['content-security-policy'], /script-src 'self'/);
});

test('knowing another participant ID does not let someone claim their ticket', async (t) => {
  const { app, enter } = fixture(t);
  const original = (await enter('Nova')).body;
  const fakeCookie = `herbi.participant=${original.me.id}.${'0'.repeat(64)}`;
  const attacker = request.agent(app);
  const state = await attacker.get('/api/state').set('Cookie', fakeCookie);
  assert.equal(state.body.me, null);
  const response = await attacker.post('/api/participate').set('Cookie', fakeCookie)
    .set('Origin', config.appUrl).send({ name: 'Luna' }).expect(200);
  assert.notEqual(response.body.me.id, original.me.id);
  assert.equal(response.body.round.total, 2);
});

test('admin login uses only the password and protects draw and new-round endpoints', async (t) => {
  const { post, admin, agent } = fixture(t);
  await post('/api/admin/draw').expect(401);
  await post('/api/admin/round').expect(401);
  await post('/api/admin/login', { password: 'wrong' }).expect(401);
  assert.equal((await admin()).body.admin, true);
  await post('/api/admin/draw').expect(409);
  await post('/api/admin/logout').expect(200);
  assert.equal((await agent.get('/api/state')).body.admin, false);
});

test('admin login and logout leave the browser ticket intact', async (t) => {
  const { enter, admin, post } = fixture(t);
  const first = (await enter()).body;
  const loggedIn = (await admin()).body;
  assert.equal(loggedIn.me.id, first.me.id);
  const loggedOut = (await post('/api/admin/logout')).body;
  assert.equal(loggedOut.me.id, first.me.id);
  assert.equal(loggedOut.me.entered, true);
});

test('mutations reject missing or foreign Origin headers', async (t) => {
  const { agent, admin } = fixture(t);
  await agent.post('/api/participate').send({ name: 'Nova' }).expect(403);
  await agent.post('/api/participate').set('Origin', 'https://other.example').send({ name: 'Nova' }).expect(403);
  await admin();
  await agent.post('/api/admin/draw').send({}).expect(403);
});

test('a draw closes participation, selects a valid equal-size slice and opens a fresh round', async (t) => {
  const { app, agent, enter, admin, post, db } = fixture(t);
  await enter('Nova');
  await enter('Luna', request.agent(app));
  await enter('Pixel', request.agent(app));
  await admin();
  const drawing = (await post('/api/admin/draw').expect(200)).body.round;
  assert.equal(drawing.status, 'drawing');
  assert.equal(drawing.winner, null);
  await enter('Late', request.agent(app)).expect(409);
  await post('/api/admin/draw').expect(409);
  await post('/api/admin/round').expect(409);
  await pause(100);
  const result = (await agent.get('/api/state')).body.round;
  assert.equal(result.status, 'finished');
  const index = result.entries.findIndex((entry) => entry.id === result.winner.id);
  assert.ok(index >= 0);
  assert.equal(Math.floor(((360 - result.draw.rotation % 360) % 360) / (360 / result.total)), index);
  const next = (await post('/api/admin/round').expect(200)).body;
  assert.equal(next.round.id, result.id + 1);
  assert.equal(next.round.total, 0);
  assert.equal(next.me.entered, false);
  assert.equal(next.me.name, 'Nova');
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM entries WHERE round_id = ?').get(result.id).total, 3);
  assert.equal((await enter('Nova').expect(200)).body.me.ticket, 1);
});

test('tickets and signed browser identity survive restart independently of the admin session', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'herbi-restart-'));
  let instance = createApp({ ...config, dataDir: directory });
  try {
    const response = await request(instance.app).post('/api/participate').set('Origin', config.appUrl).send({ name: 'Nova' });
    const cookie = response.headers['set-cookie'].find((value) => value.startsWith('herbi.participant=')).split(';')[0];
    instance.close();
    instance = createApp({ ...config, dataDir: directory });
    const { body } = await request(instance.app).get('/api/state').set('Cookie', cookie);
    assert.equal(body.me.name, 'Nova');
    assert.equal(body.me.entered, true);
    assert.equal(body.round.total, 1);
  } finally { instance.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('unfinished draws complete correctly after a restart', async (t) => {
  const { db, agent, enter } = fixture(t);
  const first = (await enter()).body.me;
  db.prepare("UPDATE rounds SET status = 'drawing', started_at = ?, duration_ms = 1, rotation = 3060, winner_id = ? WHERE id = 1")
    .run(Date.now() - 1000, first.id);
  const { body } = await agent.get('/api/state');
  assert.equal(body.round.status, 'finished');
  assert.equal(body.round.winner.id, first.id);
});

test('legacy migration retains old participants and the exact membership of previous draws', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'herbi-legacy-'));
  const legacy = new DatabaseSync(join(directory, 'giveaway.sqlite'));
  legacy.exec(`CREATE TABLE rounds (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL, started_at INTEGER, duration_ms INTEGER, rotation REAL, winner_id TEXT, requires_twitch INTEGER DEFAULT 1);
    CREATE TABLE entries (id INTEGER PRIMARY KEY AUTOINCREMENT, round_id INTEGER NOT NULL, discord_id TEXT NOT NULL,
    display_name TEXT NOT NULL, avatar TEXT, joined_at INTEGER NOT NULL, twitch_id TEXT, twitch_verified_at INTEGER,
    UNIQUE(round_id, discord_id));
    INSERT INTO rounds (id, status, created_at, winner_id) VALUES (1, 'finished', 1, '111'), (2, 'open', 2, NULL);
    INSERT INTO entries (round_id, discord_id, display_name, joined_at, twitch_id, twitch_verified_at) VALUES
    (1, '111', 'Old winner', 1, '999', 1), (1, '222', 'Never entered previous draw', 1, NULL, NULL),
    (2, '333', 'Existing participant', 2, NULL, NULL);`);
  legacy.close();
  const instance = createApp({ ...config, dataDir: directory });
  try {
    const { body } = await request(instance.app).get('/api/state');
    assert.equal(body.round.total, 1);
    assert.equal(body.round.entries[0].name, 'Existing participant');
    const columns = instance.db.prepare('PRAGMA table_info(entries)').all().map((column) => column.name);
    assert.ok(columns.includes('participant_id'));
    assert.equal(instance.db.prepare('SELECT eligible FROM entries WHERE participant_id = ?').get('222').eligible, 0);
    assert.equal(instance.db.prepare('SELECT COUNT(*) AS total FROM entries').get().total, 3);
    await request(instance.app).post('/api/participate').set('Origin', config.appUrl).send({ name: 'New participant' }).expect(200);
  } finally { instance.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('previous login sessions become browser participation and discard old access tokens', async () => {
  const db = openDatabase(':memory:');
  db.prepare('INSERT INTO entries (round_id, participant_id, display_name, joined_at) VALUES (1, ?, ?, ?)').run('12345', 'Existing member', Date.now());
  const oldStore = new SQLiteSessionStore(db, config.sessionSecret);
  const sid = 'legacy-session-id';
  await new Promise((resolve, reject) => oldStore.set(sid, {
    cookie: { originalMaxAge: 86_400_000, expires: new Date(Date.now() + 86_400_000), httpOnly: true, path: '/' },
    user: { id: '12345', name: 'Existing member' }, tokens: { accessToken: 'old-secret' }, twitchTokens: { accessToken: 'old-twitch-secret' },
  }, (error) => error ? reject(error) : resolve()));
  const signed = createHmac('sha256', config.sessionSecret).update(sid).digest('base64').replace(/=+$/, '');
  const instance = createApp(config, { db });
  try {
    const { body, headers } = await request(instance.app).get('/api/state').set('Cookie', `herbi.sid=${encodeURIComponent(`s:${sid}.${signed}`)}`);
    assert.equal(body.me.name, 'Existing member');
    assert.equal(body.me.entered, true);
    assert.ok(headers['set-cookie'].some((value) => value.startsWith('herbi.participant=')));
    const payload = oldStore.open(db.prepare('SELECT payload FROM sessions WHERE sid = ?').get(sid).payload);
    assert.equal(payload.tokens, undefined);
    assert.equal(payload.twitchTokens, undefined);
  } finally { oldStore.close(); instance.close(); }
});

test('HTTPS production cookies are secure behind the Render proxy', async (t) => {
  const { app } = fixture(t, { production: true, appUrl: 'https://example.onrender.com' });
  const response = await request(app).post('/api/participate').set('X-Forwarded-Proto', 'https')
    .set('Origin', 'https://example.onrender.com').send({ name: 'Nova' }).expect(200);
  assert.match(response.headers['set-cookie'][0], /Secure/);
  const admin = await request(app).post('/api/admin/login').set('X-Forwarded-Proto', 'https')
    .set('Origin', 'https://example.onrender.com').send({ password: config.adminPassword }).expect(200);
  assert.match(admin.headers['set-cookie'][0], /Secure/);
});

test('old external login URLs return directly to the name form', async (t) => {
  const { agent } = fixture(t);
  await agent.get('/auth/discord').expect(302).expect('Location', '/');
  await agent.get('/auth/twitch/callback?code=old').expect(302).expect('Location', '/');
});
