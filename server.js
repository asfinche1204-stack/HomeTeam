'use strict';
/*
 * server.js — Home Team: a shared weekly board for two people.
 * Render Web Service. Start: node server.js. Health: /healthz.
 *
 * Env:
 *   HOME_TEAM_KEY         shared passphrase both phones enter once (unset = open to anyone with the URL)
 *   DATABASE_URL          Neon/Postgres; when unset the board is a JSON file at HOME_TEAM_DATA_FILE
 *   HOME_TEAM_DATA_FILE   default ./data/home-team.json (mount a Render disk at /data and point here)
 *   APP_URL               public URL, used in calendar event descriptions (optional)
 *   TZ                    default America/New_York
 *   GOOGLE_SERVICE_ACCOUNT_JSON + GOOGLE_CALENDAR_ID   see calendar.js
 *   HT_VAPID_PUBLIC + HT_VAPID_PRIVATE + HT_PUSH_SUBJECT   see push.js (node server.js --vapid to generate)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const calendar = require('./calendar');
const push = require('./push');

if (process.argv.includes('--vapid')) { push.generateVapid(); process.exit(0); }

const PORT = Number(process.env.PORT) || 3000;
const KEY = (process.env.HOME_TEAM_KEY || '').trim();
const SECRET = KEY ? crypto.createHash('sha256').update('home-team-cookie:' + KEY).digest() : crypto.randomBytes(32);
const DATA_FILE = process.env.HOME_TEAM_DATA_FILE || path.join(__dirname, 'data', 'home-team.json');
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
const TZ = process.env.TZ || 'America/New_York';
const PUBLIC = path.join(__dirname, 'public');
const COLLS = ['items', 'projects', 'grocery', 'weeks', 'settings', 'feed', 'push'];
const ID_RE = /^[A-Za-z0-9_.:@+~-]{1,80}$/;
const VERSION = '2.0.0';
const FEED_CAP = 400;

/* ---------- storage: memory mirror + Postgres or JSON file ---------- */
const DB = { items: {}, projects: {}, grocery: {}, weeks: {}, settings: {}, feed: {}, push: {} };
let pool = null, fileTimer = null;

async function storeInit() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false }, max: 4, connectionTimeoutMillis: 8000, idleTimeoutMillis: 30000, keepAlive: true, keepAliveInitialDelayMillis: 10000 });
    await pool.query('CREATE TABLE IF NOT EXISTS ht_docs (coll text NOT NULL, id text NOT NULL, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (coll, id))');
    const r = await pool.query('SELECT coll, id, data FROM ht_docs');
    r.rows.forEach(row => { if (DB[row.coll]) DB[row.coll][row.id] = row.data; });
    console.log('[store] postgres, ' + r.rowCount + ' docs');
  } else {
    try { const j = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); COLLS.forEach(c => { if (j[c]) DB[c] = j[c]; }); console.log('[store] file ' + DATA_FILE); }
    catch (e) { console.log('[store] file ' + DATA_FILE + ' (new)'); }
    if (!process.env.HOME_TEAM_DATA_FILE) console.warn('[store] no DATABASE_URL and no HOME_TEAM_DATA_FILE: on Render without a disk the board is wiped on every deploy');
  }
}
async function storePut(coll, id, data) {
  DB[coll][id] = data;
  if (pool) await pool.query('INSERT INTO ht_docs (coll, id, data, updated_at) VALUES ($1, $2, $3, now()) ON CONFLICT (coll, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()', [coll, id, JSON.stringify(data)]);
  else fileSave();
}
async function storeDel(coll, id) {
  delete DB[coll][id];
  if (pool) await pool.query('DELETE FROM ht_docs WHERE coll = $1 AND id = $2', [coll, id]);
  else fileSave();
}
function fileSave() {
  clearTimeout(fileTimer);
  fileTimer = setTimeout(() => {
    try { fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); const tmp = DATA_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(DB)); fs.renameSync(tmp, DATA_FILE); }
    catch (e) { console.error('[store] write failed', e.message); }
  }, 400);
}

/* ---------- auth: passphrase -> signed cookie ---------- */
function sign(s) { return crypto.createHmac('sha256', SECRET).update(s).digest('base64url'); }
function makeCookie() { const exp = String(Date.now() + 30 * 86400e3); return exp + '.' + sign(exp); }
function cookieOk(req) {
  if (!KEY) return true;
  const m = /(?:^|;\s*)ht=([^;]+)/.exec(req.headers.cookie || ''); if (!m) return false;
  const [exp, sig] = m[1].split('.'); if (!exp || !sig) return false;
  const good = sign(exp); if (good.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return false;
  return Number(exp) > Date.now();
}
function keyOk(k) { if (!KEY) return true; const a = Buffer.from(String(k || '')), b = Buffer.from(KEY); return a.length === b.length && crypto.timingSafeEqual(a, b); }

/* ---------- live updates (SSE) ---------- */
const clients = new Set();
function broadcast(obj) { const line = 'data: ' + JSON.stringify(obj) + '\n\n'; clients.forEach(res => { try { res.write(line); } catch (e) {} }); }
setInterval(() => clients.forEach(res => { try { res.write(': ping\n\n'); } catch (e) {} }), 25000).unref();

/* ---------- helpers ---------- */
function send(res, code, body, headers) {
  const h = Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, headers || {});
  res.writeHead(code, h); res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let buf = ''; req.on('data', c => { buf += c; if (buf.length > (limit || 65536)) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.css': 'text/css; charset=utf-8' };
function serveStatic(req, res, p) {
  const file = path.join(PUBLIC, p === '/' ? 'index.html' : p);
  if (!file.startsWith(PUBLIC)) return send(res, 404, { error: 'not found' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' });
    const ext = path.extname(file);
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': ext === '.html' || file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=86400' });
    res.end(data);
  });
}
const pad = n => String(n).padStart(2, '0');
function currentWeekKey() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: process.env.TZ || 'America/New_York' }));
  now.setHours(0, 0, 0, 0); now.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
}
function calCtx() {
  const settings = DB.settings.main || {};
  return { settings, appUrl: APP_URL, save: async (id, patch) => { const cur = DB.items[id]; if (!cur) return; const next = Object.assign({}, cur, patch); await storePut('items', id, next); broadcast({ t: 'doc', coll: 'items', id, data: next }); } };
}
function withProject(item) { const p = item.projectId && DB.projects[item.projectId]; return p ? Object.assign({ projectName: p.name }, item) : item; }

/* ---------- notifications ---------- */
const names = () => Object.assign({ a: 'Alan', b: 'Her' }, (DB.settings.main && DB.settings.main.names) || {});
function notifyPref(person, key) { const n = DB.settings.main && DB.settings.main.notify && DB.settings.main.notify[person]; return !n || n[key] !== false; }
function pushSubs() { return DB.push; }
const dropSub = id => storeDel('push', id).then(() => broadcast({ t: 'doc', coll: 'push', id, data: null }));
function pushTo(person, key, payload) { if (!push.enabled || !notifyPref(person, key)) return Promise.resolve(0); return push.sendTo(person, Object.assign({ tag: key }, payload), pushSubs(), dropSub); }
function onFeed(entry) {
  if (!entry || !entry.type) return;
  const N = names(), other = entry.who === 'a' ? 'b' : 'a';
  if (entry.type === 'done') pushTo(other, 'partner', { title: N[entry.who] + ' just finished ' + (entry.title || 'something'), body: (entry.pts ? '+' + entry.pts + ' points. ' : '') + (entry.line || 'Tap to high-five.'), url: '/#team' });
  else if (entry.type === 'nudge' && entry.to) pushTo(entry.to, 'nudge', { title: N[entry.who] + ' nudged you', body: (entry.text || '') + (entry.title ? ' (' + entry.title + ')' : ''), url: '/#week' });
  else if (entry.type === 'highfive' && entry.to) pushTo(entry.to, 'highfive', { title: 'High five from ' + N[entry.who], body: entry.title ? 'For ' + entry.title : 'Nice one.', url: '/#team' });
  else if (entry.type === 'wager' && entry.text) ['a', 'b'].forEach(p => pushTo(p, 'sunday', { title: 'The wager is set', body: entry.text, url: '/#team' }));
}
function pruneFeed() {
  const ids = Object.keys(DB.feed); if (ids.length <= FEED_CAP) return;
  ids.sort((x, y) => (DB.feed[x].at || 0) - (DB.feed[y].at || 0)).slice(0, ids.length - FEED_CAP + 50).forEach(id => storeDel('feed', id).then(() => broadcast({ t: 'doc', coll: 'feed', id, data: null })));
}
function openToday(person) {
  const now = push.localNow(TZ), wk = currentWeekKey();
  return Object.values(DB.items).filter(it => !it.dropped && !it.done && it.week === wk && it.day === now.dow && (it.who === person || it.who === 'both')).map(it => it.title);
}
async function scheduler() {
  if (!push.enabled) return;
  const now = push.localNow(TZ), log = DB.settings.pushlog || {};
  if (now.hour === 19 && log.evening !== now.date) {
    await storePut('settings', 'pushlog', Object.assign({}, log, { evening: now.date }));
    for (const p of ['a', 'b']) { const open = openToday(p); if (open.length) pushTo(p, 'evening', { title: open.length + ' still open today', body: open.slice(0, 3).join(' · ') + (open.length > 3 ? ' +' + (open.length - 3) : ''), url: '/#week' }); }
  }
  if (now.dow === 6 && now.hour === 18 && log.sunday !== now.date) {
    await storePut('settings', 'pushlog', Object.assign({}, log, { sunday: now.date }));
    ['a', 'b'].forEach(p => pushTo(p, 'sunday', { title: 'Plan the week together', body: 'Five minutes: workouts, dinners, a date, one house task. Then set the wager.', url: '/#week' }));
  }
}
setInterval(() => scheduler().catch(e => console.warn('[push] scheduler', e.message)), 60000).unref();
function afterItemWrite(id, data) { calendar.syncItem(id, withProject(data), calCtx()).then(() => broadcast({ t: 'calendar', week: data.week || null })); }
function resyncFuture() {
  const cur = currentWeekKey(); let n = 0;
  Object.entries(DB.items).forEach(([id, it]) => { if (it.week && it.week >= cur && !it.dropped) { n++; calendar.syncItem(id, withProject(it), calCtx()).then(() => broadcast({ t: 'calendar', week: it.week })); } });
  if (n) console.log('[calendar] resyncing ' + n + ' scheduled items');
}

/* ---------- router ---------- */
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname, m = req.method;
  if (p === '/healthz') return send(res, 200, { ok: true, version: VERSION, store: pool ? 'postgres' : 'file', calendar: calendar.enabled, push: push.enabled, clients: clients.size });
  if (p === '/api/login' && m === 'POST') {
    const body = await readJson(req).catch(() => ({}));
    if (!keyOk(body.key)) { await new Promise(r => setTimeout(r, 600)); return send(res, 401, { error: 'wrong passphrase' }); }
    const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
    return send(res, 200, { ok: true }, { 'set-cookie': 'ht=' + makeCookie() + '; Path=/; Max-Age=' + 30 * 86400 + '; HttpOnly; SameSite=Lax' + secure });
  }
  if (p === '/api/logout' && m === 'POST') return send(res, 200, { ok: true }, { 'set-cookie': 'ht=; Path=/; Max-Age=0' });
  if (p.startsWith('/api/')) {
    if (!cookieOk(req)) return send(res, 401, { error: 'locked', needsKey: !!KEY });
    if (p === '/api/state' && m === 'GET') { const out = {}; ['items', 'projects', 'grocery', 'weeks', 'settings', 'feed'].forEach(c => { out[c] = DB[c]; }); out.pushDevices = Object.values(DB.push).map(r => ({ person: r.person, ua: r.ua || '', createdAt: r.createdAt })); out.push = { enabled: push.enabled, publicKey: push.status.publicKey }; out.calendar = calendar.status; out.locked = !!KEY; out.version = VERSION; return send(res, 200, out); }
    if (p === '/api/push/subscribe' && m === 'POST') {
      let body; try { body = await readJson(req, 16384); } catch (e) { return send(res, 400, { error: e.message }); }
      if (!push.enabled) return send(res, 200, { ok: false, reason: 'push not configured' });
      if (!body || !body.sub || !body.sub.endpoint || !['a', 'b'].includes(body.person)) return send(res, 400, { error: 'need person and sub' });
      const id = crypto.createHash('sha256').update(body.sub.endpoint).digest('hex').slice(0, 24);
      await storePut('push', id, { person: body.person, sub: body.sub, createdAt: Date.now(), ua: String(req.headers['user-agent'] || '').slice(0, 80) });
      return send(res, 200, { ok: true, id });
    }
    if (p === '/api/push/unsubscribe' && m === 'POST') {
      let body; try { body = await readJson(req, 16384); } catch (e) { return send(res, 400, { error: e.message }); }
      if (body && body.endpoint) { const id = crypto.createHash('sha256').update(body.endpoint).digest('hex').slice(0, 24); await storeDel('push', id); }
      return send(res, 200, { ok: true });
    }
    if (p === '/api/push/test' && m === 'POST') {
      let body; try { body = await readJson(req, 1024); } catch (e) { body = {}; }
      const person = ['a', 'b'].includes(body.person) ? body.person : 'a';
      const n = await push.sendTo(person, { title: 'Home Team is talking to this phone', body: 'Notifications are on.', tag: 'test', url: '/' }, pushSubs(), dropSub);
      return send(res, 200, { ok: true, sent: n });
    }
    if (p === '/api/calendar' && m === 'GET') {
      const wk = url.searchParams.get('week') || currentWeekKey();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(wk)) return send(res, 400, { error: 'bad week' });
      try { return send(res, 200, await calendar.listWeek(wk, url.searchParams.get('force') === '1')); }
      catch (e) { calendar.status.lastError = e.message; return send(res, 200, { connected: true, events: [], error: e.message }); }
    }
    if (p === '/api/events' && m === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(': hello\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
    }
    const dm = /^\/api\/doc\/([a-z]+)\/([^/]+)$/.exec(p);
    if (dm) {
      const coll = dm[1], id = decodeURIComponent(dm[2]);
      if (!COLLS.includes(coll) || coll === 'push' || !ID_RE.test(id)) return send(res, 400, { error: 'bad path' });
      if (m === 'PUT') {
        let data; try { data = await readJson(req, 65536); } catch (e) { return send(res, 400, { error: e.message }); }
        if (!data || typeof data !== 'object' || Array.isArray(data)) return send(res, 400, { error: 'body must be an object' });
        const prev = DB[coll][id];
        if (coll === 'items' && prev && prev.gcalEventId && !data.gcalEventId) data.gcalEventId = prev.gcalEventId; // clients never carry the event id
        await storePut(coll, id, data); broadcast({ t: 'doc', coll, id, data });
        if (coll === 'items') afterItemWrite(id, data);
        if (coll === 'feed' && !prev) { onFeed(data); pruneFeed(); }
        if (coll === 'settings' && id === 'main') { const a = JSON.stringify([(prev || {}).names, (prev || {}).calendarAreas]), b = JSON.stringify([data.names, data.calendarAreas]); if (a !== b) resyncFuture(); }
        if (coll === 'projects' && prev && prev.name !== data.name) Object.entries(DB.items).forEach(([iid, it]) => { if (it.projectId === id && it.week) afterItemWrite(iid, it); });
        return send(res, 200, { ok: true });
      }
      if (m === 'DELETE') {
        const prev = DB[coll][id];
        await storeDel(coll, id); broadcast({ t: 'doc', coll, id, data: null });
        if (coll === 'items' && prev) calendar.removeItem(id, prev).then(() => broadcast({ t: 'calendar', week: prev.week || null }));
        return send(res, 200, { ok: true });
      }
    }
    return send(res, 404, { error: 'not found' });
  }
  if (m !== 'GET' && m !== 'HEAD') return send(res, 405, { error: 'method' });
  if (/^\/(ex\/)?[A-Za-z0-9._-]*$/.test(p) && !p.includes('..')) return serveStatic(req, res, p);
  return send(res, 404, { error: 'not found' });
}

storeInit().then(() => {
  http.createServer((req, res) => handle(req, res).catch(e => { console.error('[http]', e); try { send(res, 500, { error: 'server error' }); } catch (x) {} })).listen(PORT, () => {
    console.log('Home Team v' + VERSION + ' on :' + PORT + (KEY ? ' (passphrase set)' : ' (NO HOME_TEAM_KEY: open to anyone with the URL)'));
    calendar.probe();
  });
}).catch(e => { console.error('[boot] store failed', e); process.exit(1); });
