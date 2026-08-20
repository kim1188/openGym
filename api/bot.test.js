// Synthetic fixtures in os.tmpdir() only. Never read the repo's committed data/.
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleBot, buildToday, buildSummary, parseWorkout, applyWorkout, applyWeight, parseWeight, effectiveRoutineId } from './bot.js';

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const FIXTURE = {
  unit: 'kg',
  _ts: 1,
  keepMe: 'yes',
  reminder: { on: true, time: '08:00', tz: 'UTC' },
  routines: [{
    id: 'r-push', name: 'Push', emoji: '💪',
    ex: [{ id: '0025', sets: 3, reps: 8, weight: 60, mode: 'reps' }]
  }],
  week: { 1: 'r-push', 3: 'r-push', 5: 'r-push' },
  dayPlan: {},
  exWeights: { '0025': { w: 62.5, d: '2026-08-18' } },
  customEx: [{ id: 'c1', name: 'Neck curl', bp: 'neck' }],
  bodyweight: [
    { d: '2026-08-17', w: 81.2, t: 1 },
    { d: '2026-08-19', w: 80.8, t: 2 }
  ],
  workouts: [{
    id: 'w1', d: '2026-08-18', start: 1, end: 2, routineId: 'r-push', name: 'Push',
    bw: 81, vol: 1500, prs: [],
    entries: [{ id: '0025', sets: [{ w: 62.5, r: 8, done: true }], topW: 62.5, target: { sets: 3, reps: 8 } }]
  }],
  settingsExtra: { foo: 1 }
};

function atomicWrite(file, content) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function makeCtx(dir, db) {
  const stateFile = uid => path.join(dir, 'state-' + uid.replace(/[^a-zA-Z0-9_-]/g, '') + '.json');
  return {
    json, readBody: req => {
      return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', d => chunks.push(d));
        req.on('end', () => {
          try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
          catch { reject(new Error('bad json')); }
        });
        req.on('error', reject);
      });
    },
    readState: uid => {
      try { return JSON.parse(fs.readFileSync(stateFile(uid), 'utf8')); } catch { return null; }
    },
    atomicWrite, stateFile, db
  };
}

function listen(ctx) {
  return new Promise(resolve => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/api/health') return json(res, 200, { ok: true });
      if (url.pathname === '/api/bot' || url.pathname.startsWith('/api/bot/')) {
        try { await handleBot(req, res, url, ctx); }
        catch (e) { json(res, 500, { error: String(e.message) }); }
        return;
      }
      json(res, 404, { error: 'not found' });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

async function call(base, method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token !== undefined) headers.Authorization = token === null ? '' : `Bearer ${token}`;
  const res = await fetch(base + path, {
    method, headers, body: body != null ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

const UID = 'user-fixture';
const TOKEN = 'test-bot-token-32bytes-long!!!!';

describe('bot API auth', () => {
  let dir, ctx, server, base;
  const prev = { BOT_TOKEN: process.env.BOT_TOKEN, BOT_UID: process.env.BOT_UID };

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-bot-'));
    fs.writeFileSync(path.join(dir, 'state-' + UID + '.json'), JSON.stringify(FIXTURE));
    ctx = makeCtx(dir, { users: [{ id: UID, name: 'Pat' }] });
    ({ server, base } = await listen(ctx));
  });
  after(() => {
    server.close();
    process.env.BOT_TOKEN = prev.BOT_TOKEN;
    process.env.BOT_UID = prev.BOT_UID;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns 404 for every /api/bot/* route when BOT_TOKEN is unset (feature off)', async () => {
    delete process.env.BOT_TOKEN;
    process.env.BOT_UID = UID;
    for (const p of ['/api/bot/today', '/api/bot/summary', '/api/bot/state']) {
      const r = await call(base, 'GET', p, { token: TOKEN });
      assert.equal(r.status, 404, p);
    }
    const post = await call(base, 'POST', '/api/bot/weight', { token: TOKEN, body: { w: 80 } });
    assert.equal(post.status, 404);
    const health = await call(base, 'GET', '/api/health');
    assert.equal(health.status, 200);
  });

  it('returns 401 for a missing or wrong token; no session cookie needed', async () => {
    process.env.BOT_TOKEN = TOKEN;
    process.env.BOT_UID = UID;
    const missing = await call(base, 'GET', '/api/bot/today');
    assert.equal(missing.status, 401);
    const wrong = await call(base, 'GET', '/api/bot/today', { token: 'nope' });
    assert.equal(wrong.status, 401);
    const empty = await fetch(base + '/api/bot/today', { headers: { Authorization: 'Bearer ' } });
    assert.equal(empty.status, 401);
  });

  it('returns 403 when BOT_UID is unknown', async () => {
    process.env.BOT_TOKEN = TOKEN;
    process.env.BOT_UID = 'nobody';
    const r = await call(base, 'GET', '/api/bot/today', { token: TOKEN });
    assert.equal(r.status, 403);
    assert.match(r.data.error, /unknown/i);
  });

  it('returns 400 when BOT_UID is not configured', async () => {
    process.env.BOT_TOKEN = TOKEN;
    delete process.env.BOT_UID;
    const r = await call(base, 'GET', '/api/bot/today', { token: TOKEN });
    assert.equal(r.status, 400);
  });
});

describe('bot today / summary against a fixture state', () => {
  let dir, ctx, server, base;
  const prev = { BOT_TOKEN: process.env.BOT_TOKEN, BOT_UID: process.env.BOT_UID };

  before(async () => {
    process.env.BOT_TOKEN = TOKEN;
    process.env.BOT_UID = UID;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-bot-'));
    const today = new Date().toISOString().slice(0, 10);
    const state = { ...FIXTURE, dayPlan: { ...FIXTURE.dayPlan, [today]: 'r-push' } };
    fs.writeFileSync(path.join(dir, 'state-' + UID + '.json'), JSON.stringify(state));
    ctx = makeCtx(dir, { users: [{ id: UID, name: 'Pat' }] });
    ({ server, base } = await listen(ctx));
  });
  after(() => {
    server.close();
    process.env.BOT_TOKEN = prev.BOT_TOKEN;
    process.env.BOT_UID = prev.BOT_UID;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('GET /api/bot/today honors dayPlan + last logged weights', async () => {
    const r = await call(base, 'GET', '/api/bot/today', { token: TOKEN });
    assert.equal(r.status, 200);
    assert.equal(r.data.tz, 'UTC');
    assert.match(r.data.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(r.data.logged, false);
    assert.equal(r.data.rest, false);
    assert.equal(r.data.routine.id, 'r-push');
    assert.equal(r.data.last['0025'].stored.w, 62.5);
    assert.equal(r.data.last['0025'].last.d, '2026-08-18');
  });

  it('honors dayPlan overrides the same way the reminder does', () => {
    // 2099-01-05 is a Monday (week[1] = r-push); rest override wins, unknown id is ignored.
    assert.equal(effectiveRoutineId({ ...FIXTURE, dayPlan: { '2099-01-05': 'rest' } }, '2099-01-05'), null);
    assert.equal(effectiveRoutineId({ ...FIXTURE, dayPlan: { '2099-01-05': 'nope' } }, '2099-01-05'), 'r-push');
    assert.equal(effectiveRoutineId({ ...FIXTURE, dayPlan: { '2099-01-06': 'r-push' } }, '2099-01-06'), 'r-push');
    assert.equal(effectiveRoutineId({ ...FIXTURE, dayPlan: {} }, '2099-01-05'), 'r-push');
  });

  it('GET /api/bot/summary is compact: recent workouts, bodyweight, routines, week — not a library', async () => {
    const r = await call(base, 'GET', '/api/bot/summary', { token: TOKEN });
    assert.equal(r.status, 200);
    assert.equal(r.data.unit, 'kg');
    assert.equal(r.data.workouts.length, 1);
    assert.equal(r.data.workouts[0].d, '2026-08-18');
    assert.equal(r.data.bodyweight.length, 2);
    assert.equal(r.data.routines[0].id, 'r-push');
    assert.deepEqual(r.data.week, FIXTURE.week);
    assert.equal(r.data.customEx[0].id, 'c1');
    assert.equal(r.data.library, undefined);
  });

  it('GET /api/bot/state returns the full file', async () => {
    const r = await call(base, 'GET', '/api/bot/state', { token: TOKEN });
    assert.equal(r.status, 200);
    assert.equal(r.data.state.keepMe, 'yes');
    assert.equal(r.data.state.workouts.length, 1);
  });
});

describe('bot writes preserve unrelated fields', () => {
  let dir, ctx, server, base;
  const prev = { BOT_TOKEN: process.env.BOT_TOKEN, BOT_UID: process.env.BOT_UID };

  beforeEach(async () => {
    process.env.BOT_TOKEN = TOKEN;
    process.env.BOT_UID = UID;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-bot-w-'));
    fs.writeFileSync(path.join(dir, 'state-' + UID + '.json'), JSON.stringify(FIXTURE));
    ctx = makeCtx(dir, { users: [{ id: UID, name: 'Pat' }] });
    ({ server, base } = await listen(ctx));
  });
  afterEach(() => {
    server.close();
    process.env.BOT_TOKEN = prev.BOT_TOKEN;
    process.env.BOT_UID = prev.BOT_UID;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('POST /api/bot/workout appends without dropping routines/week/exWeights/older workouts', async () => {
    const r = await call(base, 'POST', '/api/bot/workout', {
      token: TOKEN,
      body: {
        d: '2026-08-20',
        name: 'Push',
        routineId: 'r-push',
        entries: [{ id: '0025', sets: [{ w: 65, r: 8, done: true }], target: { sets: 3, reps: 8, mode: 'reps' } }]
      }
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.workout.d, '2026-08-20');
    assert.equal(r.data.workout.entries[0].sets[0].w, 65);
    assert.ok(r.data.workout.vol > 0);
    const S = JSON.parse(fs.readFileSync(path.join(dir, 'state-' + UID + '.json'), 'utf8'));
    assert.equal(S.keepMe, 'yes');
    assert.equal(S.settingsExtra.foo, 1);
    assert.equal(S.routines[0].id, 'r-push');
    assert.deepEqual(S.week, FIXTURE.week);
    assert.equal(S.workouts.length, 2);
    assert.equal(S.workouts[0].d, '2026-08-18');
    assert.equal(S.exWeights['0025'].w, 65);
    assert.equal(S.bodyweight.length, 2);
    assert.equal(S.customEx[0].id, 'c1');
    assert.ok(S._ts > 1);
    assert.equal(S.active, undefined);
  });

  it('POST /api/bot/workout rejects a second workout on the same date unless replace: true', async () => {
    const first = await call(base, 'POST', '/api/bot/workout', {
      token: TOKEN,
      body: { d: '2026-08-18', name: 'Dup', entries: [{ id: '0025', sets: [{ w: 70, r: 5 }] }] }
    });
    assert.equal(first.status, 409);
    const repl = await call(base, 'POST', '/api/bot/workout', {
      token: TOKEN,
      body: { d: '2026-08-18', name: 'Replaced', replace: true, entries: [{ id: '0025', sets: [{ w: 70, r: 5, done: true }] }] }
    });
    assert.equal(repl.status, 200);
    const S = JSON.parse(fs.readFileSync(path.join(dir, 'state-' + UID + '.json'), 'utf8'));
    assert.equal(S.workouts.length, 1);
    assert.equal(S.workouts[0].name, 'Replaced');
    assert.equal(S.keepMe, 'yes');
  });

  it('POST /api/bot/weight upserts one bodyweight point and leaves the rest of the file alone', async () => {
    const r = await call(base, 'POST', '/api/bot/weight', { token: TOKEN, body: { d: '2026-08-20', w: 80.4 } });
    assert.equal(r.status, 200);
    assert.equal(r.data.entry.w, 80.4);
    const again = await call(base, 'POST', '/api/bot/weight', { token: TOKEN, body: { date: '2026-08-20', weight: 80.6 } });
    assert.equal(again.status, 200);
    assert.equal(again.data.updated, true);
    const S = JSON.parse(fs.readFileSync(path.join(dir, 'state-' + UID + '.json'), 'utf8'));
    assert.equal(S.bodyweight.filter(b => b.d === '2026-08-20').length, 1);
    assert.equal(S.bodyweight.find(b => b.d === '2026-08-20').w, 80.6);
    assert.equal(S.workouts.length, 1);
    assert.equal(S.keepMe, 'yes');
    assert.equal(S.active, undefined);
  });

  it('does not invent set fields the app will not read', () => {
    const parsed = parseWorkout({
      d: '2026-08-21',
      entries: [{ id: '0025', sets: [{ w: 60, r: 8, done: true, fakeField: 1, oneRepMax: 99 }] }]
    });
    assert.equal(parsed.workout.entries[0].sets[0].fakeField, undefined);
    assert.equal(parsed.workout.entries[0].sets[0].oneRepMax, undefined);
    assert.equal(parsed.workout.entries[0].sets[0].w, 60);
  });
});

describe('pure helpers', () => {
  it('buildToday treats a missing dayPlan/week as rest', () => {
    const t = buildToday({ routines: [], week: {}, dayPlan: {}, workouts: [] });
    assert.equal(t.rest, true);
    assert.equal(t.routine, null);
    assert.equal(t.logged, false);
  });

  it('buildSummary caps n and newest-first', () => {
    const workouts = Array.from({ length: 3 }, (_, i) => ({ d: '2026-08-0' + (i + 1), entries: [] }));
    const s = buildSummary({ workouts, bodyweight: [], routines: [], week: {} }, 2);
    assert.equal(s.workouts.length, 2);
    assert.equal(s.workouts[0].d, '2026-08-03');
  });

  it('parseWorkout / parseWeight reject junk', () => {
    assert.ok(parseWorkout({}).error);
    assert.ok(parseWorkout({ d: '2026-13-99', entries: [{ id: 'x', sets: [{ w: 1, r: 1 }] }] }).error);
    assert.ok(parseWeight({ w: 0 }).error);
    assert.ok(parseWeight({ w: -1, d: '2026-08-01' }).error);
  });

  it('applyWorkout + applyWeight do not drop unknown top-level keys', () => {
    const S = { ...JSON.parse(JSON.stringify(FIXTURE)) };
    applyWorkout(S, parseWorkout({
      d: '2026-08-22', entries: [{ id: '0025', sets: [{ w: 60, r: 8, done: true }] }]
    }));
    applyWeight(S, parseWeight({ w: 79.9, d: '2026-08-22' }).entry);
    assert.equal(S.keepMe, 'yes');
    assert.equal(S.settingsExtra.foo, 1);
  });
});
