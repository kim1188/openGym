/* Bot token API — Bearer auth acting as one existing user (BOT_UID).
   Off unless BOT_TOKEN is set, same spirit as ADMIN_UIDS defaulting off.
   Read/write the same state-<uid>.json files; never a second store.     */
import crypto from 'node:crypto';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_TZ = 'UTC';
const SUMMARY_N = 10;
const SUMMARY_N_MAX = 50;
const BW_N = 30;
const BW_N_MAX = 90;

export function botToken() { return String(process.env.BOT_TOKEN || '').trim(); }
export function botUid() { return String(process.env.BOT_UID || '').trim(); }
export const botEnabled = () => !!botToken();

// Length-mismatch still runs a compare so a wrong-length guess isn't a faster 401.
export function tokenEq(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (!A.length || A.length !== B.length) {
    crypto.timingSafeEqual(A.length ? A : Buffer.from('x'), A.length ? A : Buffer.from('x'));
    return false;
  }
  return crypto.timingSafeEqual(A, B);
}

export function bearerToken(req) {
  const raw = req.headers.authorization || req.headers.Authorization || '';
  const m = String(raw).match(/^Bearer\s+(\S+)/i);
  return m ? m[1] : '';
}

// Same helper the reminder already uses (copied, not imported — two runtimes).
export function effectiveRoutineId(S, iso) {
  const ov = S.dayPlan?.[iso];
  if (ov === 'rest') return null;
  if (ov && S.routines?.some(r => r.id === ov)) return ov;
  const wd = new Date(iso + 'T12:00:00').getDay();
  return S.week?.[wd] || null;
}

export function userNow(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).formatToParts(new Date());
    const g = t => parts.find(p => p.type === t)?.value;
    return { date: `${g('year')}-${g('month')}-${g('day')}`, hhmm: `${g('hour')}:${g('minute')}` };
  } catch { return null; }
}

export function todayFor(S) {
  const wanted = (S?.reminder?.tz || '').trim() || DEFAULT_TZ;
  const now = userNow(wanted) || userNow(DEFAULT_TZ);
  return { date: now.date, tz: userNow(wanted) ? wanted : DEFAULT_TZ };
}

export function isIsoDate(s) {
  if (!ISO_DATE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function lastEntryFor(S, exId) {
  const workouts = S.workouts || [];
  for (let i = workouts.length - 1; i >= 0; i--) {
    const en = (workouts[i].entries || []).find(e => e.id === exId);
    if (en && (en.sets || []).some(s => s.done))
      return { d: workouts[i].d, sets: en.sets.filter(s => s.done), target: en.target || null, topW: en.topW || null };
  }
  return null;
}

function workoutVolume(w) {
  let v = 0;
  (w.entries || []).forEach(e => (e.sets || []).forEach(s => { if (s.done) v += (s.w || 0) * (s.r || 0); }));
  return v;
}

function compactRoutine(r) {
  if (!r) return null;
  return {
    id: r.id, name: r.name, emoji: r.emoji || null,
    ex: (r.ex || []).map(e => ({
      id: e.id, sets: e.sets, reps: e.reps, weight: e.weight,
      mode: e.mode, min: e.min, speed: e.speed, sec: e.sec,
      bodyweight: e.bodyweight, side: e.side, sg: e.sg, prog: e.prog
    }))
  };
}

export function buildToday(S) {
  const { date, tz } = todayFor(S);
  const rid = effectiveRoutineId(S || {}, date);
  const routine = rid ? (S.routines || []).find(r => r.id === rid) || null : null;
  const logged = (S.workouts || []).filter(w => w.d === date);
  const last = {};
  for (const cfg of routine?.ex || []) {
    last[cfg.id] = {
      last: lastEntryFor(S, cfg.id),
      stored: S.exWeights?.[cfg.id] || null
    };
  }
  return {
    date, tz,
    weekday: new Date(date + 'T12:00:00').getDay(),
    rest: !rid,
    logged: logged.length > 0,
    workouts: logged,
    routine: compactRoutine(routine),
    last
  };
}

export function buildSummary(S, n = SUMMARY_N, bwN = BW_N) {
  const take = Math.max(1, Math.min(SUMMARY_N_MAX, n | 0 || SUMMARY_N));
  const takeBw = Math.max(1, Math.min(BW_N_MAX, bwN | 0 || BW_N));
  const workouts = (S.workouts || []).slice(-take).reverse();
  const bodyweight = (S.bodyweight || []).slice(-takeBw);
  return {
    unit: S.unit || 'kg',
    tz: (S.reminder?.tz || '').trim() || DEFAULT_TZ,
    workouts,
    bodyweight,
    routines: (S.routines || []).map(compactRoutine),
    week: S.week || {},
    customEx: (S.customEx || []).map(e => ({ id: e.id, name: e.name, bp: e.bp }))
  };
}

const SET_KEYS = ['w', 'r', 'done', 'sec', 'min', 'speed', 'rir', 'rpe'];

function cleanSet(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const s = {};
  for (const k of SET_KEYS) if (raw[k] != null) s[k] = raw[k];
  if (s.done == null) s.done = true;   // this endpoint appends a *completed* workout
  return s;
}

function cleanEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  if (!id) return null;
  const sets = Array.isArray(raw.sets) ? raw.sets.map(cleanSet).filter(Boolean) : [];
  if (!sets.length) return null;
  const e = { id, sets };
  if (raw.topW != null) e.topW = raw.topW;
  if (raw.target && typeof raw.target === 'object') e.target = raw.target;
  if (raw.sg) e.sg = raw.sg;
  return e;
}

export function parseWorkout(body) {
  const src = (body && typeof body.workout === 'object' && body.workout) || body || {};
  const d = String(src.d || src.date || '').trim();
  const rawEntries = src.entries || src.exercises;
  if (!isIsoDate(d)) return { error: 'date required (YYYY-MM-DD)' };
  if (!Array.isArray(rawEntries) || !rawEntries.length) return { error: 'entries required' };
  const entries = rawEntries.map(cleanEntry).filter(e => e && e.sets.some(s => s.done));
  if (!entries.length) return { error: 'at least one completed set is required' };
  const now = Date.now();
  const w = {
    id: String(src.id || '').trim() || (now.toString(36) + Math.random().toString(36).slice(2, 7)),
    d,
    start: Number.isFinite(+src.start) ? +src.start : now,
    end: Number.isFinite(+src.end) ? +src.end : now,
    routineId: src.routineId || null,
    name: src.name != null ? String(src.name).slice(0, 80) : 'Workout',
    bw: src.bw != null && Number.isFinite(+src.bw) ? +src.bw : null,
    entries,
    prs: Array.isArray(src.prs) ? src.prs : []
  };
  w.vol = Number.isFinite(+src.vol) ? +src.vol : workoutVolume(w);
  return { workout: w, replace: !!body.replace };
}

export function applyWorkout(S, parsed) {
  const { workout: w, replace } = parsed;
  S.workouts = S.workouts || [];
  S.exWeights = S.exWeights || {};
  const exists = S.workouts.some(x => x.d === w.d);
  if (exists && !replace) return { error: 'a workout for that date already exists', status: 409 };
  if (exists && replace) S.workouts = S.workouts.filter(x => x.d !== w.d);
  w.entries.forEach(e => {
    const mx = Math.max(0, ...e.sets.filter(x => x.done).map(x => x.w || 0), e.topW || 0);
    if (mx > 0) {
      const cur = S.exWeights[e.id];
      if (!cur || mx > cur.w) S.exWeights[e.id] = { w: mx, d: w.d };
    }
  });
  S.workouts.push(w);
  return { workout: w };
}

export function parseWeight(body, fallbackDate) {
  const w = +(body.w ?? body.weight);
  if (!Number.isFinite(w) || w <= 0) return { error: 'weight required (positive number)' };
  const d = String(body.d || body.date || fallbackDate || '').trim();
  if (!isIsoDate(d)) return { error: 'date required (YYYY-MM-DD)' };
  return { entry: { d, w: Math.round(w * 10) / 10, t: Number.isFinite(+body.t) ? +body.t : Date.now() } };
}

export function applyWeight(S, entry) {
  S.bodyweight = S.bodyweight || [];
  const ex = S.bodyweight.find(b => b.d === entry.d);
  if (ex) { ex.w = entry.w; ex.t = entry.t; }
  else S.bodyweight.push(entry);
  S.bodyweight.sort((a, b) => (a.d < b.d ? -1 : 1));
  return ex ? { updated: true, entry: ex } : { updated: false, entry };
}

function emptyState() {
  return {
    unit: 'kg', bodyweight: [], routines: [], week: {}, dayPlan: {},
    exWeights: {}, workouts: [], customEx: []
  };
}

function writeState(ctx, uid, S) {
  delete S.active;            // in-progress workouts stay device-local — same as PUT /api/data
  S._ts = Date.now();
  ctx.atomicWrite(ctx.stateFile(uid), JSON.stringify(S));
}

function loadState(ctx, uid) {
  const S = ctx.readState(uid);
  return S && typeof S === 'object' ? S : emptyState();
}

function resolveBotUser(ctx) {
  const uid = botUid();
  if (!uid) return { error: 'BOT_UID is not configured', status: 400 };
  const user = (ctx.db.users || []).find(u => u.id === uid) || null;
  if (!user) return { error: 'unknown BOT_UID', status: 403 };
  if (user.disabled) return { error: 'this account has been disabled', status: 403 };
  return { user };
}

export async function handleBot(req, res, url, ctx) {
  if (!botEnabled()) return ctx.json(res, 404, { error: 'not found' });

  const tok = bearerToken(req);
  if (!tok || !tokenEq(tok, botToken())) return ctx.json(res, 401, { error: 'unauthorized' });

  const who = resolveBotUser(ctx);
  if (who.error) return ctx.json(res, who.status, { error: who.error });
  const uid = who.user.id;

  const path = url.pathname;
  const key = req.method + ' ' + path;

  if (key === 'GET /api/bot/today') {
    return ctx.json(res, 200, buildToday(loadState(ctx, uid)));
  }

  if (key === 'GET /api/bot/summary') {
    const n = +(url.searchParams.get('n') || url.searchParams.get('limit') || SUMMARY_N);
    const bwN = +(url.searchParams.get('bw') || BW_N);
    return ctx.json(res, 200, buildSummary(loadState(ctx, uid), n, bwN));
  }

  if (key === 'GET /api/bot/state') {
    const state = ctx.readState(uid);
    return ctx.json(res, 200, { state });
  }

  if (key === 'POST /api/bot/workout') {
    const body = await ctx.readBody(req);
    const parsed = parseWorkout(body);
    if (parsed.error) return ctx.json(res, 400, { error: parsed.error });
    const S = loadState(ctx, uid);
    const out = applyWorkout(S, parsed);
    if (out.error) return ctx.json(res, out.status || 400, { error: out.error });
    writeState(ctx, uid, S);
    return ctx.json(res, 200, { ok: true, workout: out.workout, ts: S._ts });
  }

  if (key === 'POST /api/bot/weight') {
    const body = await ctx.readBody(req);
    const S = loadState(ctx, uid);
    const parsed = parseWeight(body, todayFor(S).date);
    if (parsed.error) return ctx.json(res, 400, { error: parsed.error });
    const out = applyWeight(S, parsed.entry);
    writeState(ctx, uid, S);
    return ctx.json(res, 200, { ok: true, ...out, ts: S._ts });
  }

  return ctx.json(res, 404, { error: 'not found' });
}
