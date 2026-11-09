'use strict';
/*
 * calendar.js — Google Calendar sync for Home Team.
 * Auth: a Google service account (no OAuth screens). Share the calendar with the
 * service account's client_email ("Make changes to events") and set:
 *   GOOGLE_SERVICE_ACCOUNT_JSON  the key file's contents (raw JSON or base64)
 *   GOOGLE_CALENDAR_ID           e.g. abc123@group.calendar.google.com
 *   TZ                           default America/New_York
 * Board -> calendar: scheduled items become events (all-day, or timed when the
 * item has a time). Done items get a check mark; unscheduled/deleted items are
 * removed. Calendar -> board: listWeek() returns the week's events for display.
 * Node 20+: uses global fetch and crypto; no npm dependencies.
 */
const crypto = require('crypto');

const TZ = process.env.TZ || 'America/New_York';
const CAL_ID = (process.env.GOOGLE_CALENDAR_ID || '').trim();
const SA = parseServiceAccount(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
const ENABLED = !!(SA && SA.client_email && SA.private_key && CAL_ID);
const API = 'https://www.googleapis.com/calendar/v3';
const AREAS = { workout: 'Workout', house: 'House', date: 'Date', meal: 'Dinner' };
const DEFAULT_AREAS = { workout: true, house: true, date: true, meal: false };

const status = { connected: ENABLED, calendarId: ENABLED ? CAL_ID : null, calendarName: null, lastSync: null, lastError: null, timeZone: TZ };
let token = { value: null, exp: 0 };
const weekCache = new Map(); // weekKey -> { at, events }
const queues = new Map();    // itemId -> promise chain
let fetchImpl = (...a) => globalThis.fetch(...a);

function parseServiceAccount(raw) {
  if (!raw) return null;
  let s = raw.trim();
  try {
    if (!s.startsWith('{')) s = Buffer.from(s, 'base64').toString('utf8');
    const j = JSON.parse(s);
    if (j.private_key) j.private_key = j.private_key.replace(/\\n/g, '\n');
    return j;
  } catch (e) { console.warn('[calendar] GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON or base64 JSON'); return null; }
}
const b64url = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function accessToken() {
  if (token.value && Date.now() < token.exp - 60000) return token.value;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: SA.client_email, scope: 'https://www.googleapis.com/auth/calendar', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(header + '.' + claims), SA.private_key);
  const assertion = header + '.' + claims + '.' + b64url(sig);
  const r = await fetchImpl('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + assertion });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('token ' + r.status + ' ' + (j.error_description || j.error || ''));
  token = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return token.value;
}

async function gapi(method, path, body, query) {
  const url = new URL(API + path);
  if (query) Object.entries(query).forEach(([k, v]) => { if (v != null) url.searchParams.set(k, v); });
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = await accessToken();
    const r = await fetchImpl(url, { method, headers: { authorization: 'Bearer ' + t, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401 && attempt === 0) { token = { value: null, exp: 0 }; continue; }
    if (r.status === 204) return null;
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const err = new Error('calendar ' + r.status + ' ' + ((j.error && j.error.message) || '')); err.status = r.status; throw err; }
    return j;
  }
}

/* ---------- dates ---------- */
const pad = n => String(n).padStart(2, '0');
function parseKey(k) { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function keyOf(d) { return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
function addDays(k, n) { const d = parseKey(k); d.setUTCDate(d.getUTCDate() + n); return keyOf(d); }
function itemDate(item) { return item.week && item.day != null ? addDays(item.week, Number(item.day)) : null; }
function addMinutes(time, mins) { const [h, m] = time.split(':').map(Number); const t = h * 60 + m + mins; return pad(Math.floor(t / 60) % 24) + ':' + pad(t % 60); }

/* ---------- board -> calendar ---------- */
function shouldHaveEvent(item, ctx) {
  if (!item || item.dropped) return false;
  if (!itemDate(item)) return false;
  const areas = Object.assign({}, DEFAULT_AREAS, (ctx.settings && ctx.settings.calendarAreas) || {});
  return !!areas[item.area];
}
function eventBody(item, ctx) {
  const names = Object.assign({ a: 'Alan', b: 'Her' }, (ctx.settings && ctx.settings.names) || {});
  const who = item.who === 'both' ? names.a + ' & ' + names.b : (names[item.who] || '');
  const date = itemDate(item);
  const body = {
    summary: (item.done ? '✓ ' : '') + item.title + (who ? ' · ' + who : ''),
    description: 'Home Team · ' + (AREAS[item.area] || item.area) + (item.projectName ? ' · ' + item.projectName : '') + (item.place ? '\n📍 ' + (item.placeName ? item.placeName + ' · ' : '') + item.place : '') + (item.notes ? '\n' + item.notes : '') + (ctx.appUrl ? '\n' + ctx.appUrl : ''),
    extendedProperties: { private: { homeTeamId: item.id, homeTeamArea: item.area } }
  };
  // the place is the event's location (the exact Maps link or the address, tappable in Google Calendar); the name goes in the description
  if (item.place) body.location = item.place;
  else { const m = (item.notes || '').match(/https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|(?:www\.)?google\.[a-z.]{2,8}\/maps|maps\.google\.[a-z.]{2,8})\S*/i); if (m) body.location = m[0]; }
  if (item.time && /^\d{2}:\d{2}$/.test(item.time)) {
    const mins = Number(item.duration) > 0 ? Number(item.duration) : 60;
    const endTime = addMinutes(item.time, mins), endDate = endTime < item.time ? addDays(date, 1) : date;
    body.start = { dateTime: date + 'T' + item.time + ':00', timeZone: TZ };
    body.end = { dateTime: endDate + 'T' + endTime + ':00', timeZone: TZ };
  } else {
    body.start = { date }; body.end = { date: addDays(date, 1) };
  }
  return body;
}
function enqueue(id, fn) { const p = (queues.get(id) || Promise.resolve()).then(fn).catch(e => { status.lastError = e.message; console.warn('[calendar]', id, e.message); }); queues.set(id, p); return p; }

/** Make the calendar match this item. ctx: { settings, appUrl, save(id, patch) }. Returns a promise; errors are logged, never thrown. */
function syncItem(id, item, ctx) {
  if (!ENABLED) return Promise.resolve();
  return enqueue(id, async () => {
    const want = shouldHaveEvent(item, ctx), eid = item && item.gcalEventId;
    if (!want) { if (eid) { await deleteEvent(eid); await ctx.save(id, { gcalEventId: null }); invalidate(item && item.week); } return; }
    const body = eventBody(Object.assign({}, item, { id }), ctx);
    if (eid) {
      try { await gapi('PATCH', '/calendars/' + encodeURIComponent(CAL_ID) + '/events/' + encodeURIComponent(eid), body); }
      catch (e) { if (e.status === 404 || e.status === 410) { const ev = await gapi('POST', '/calendars/' + encodeURIComponent(CAL_ID) + '/events', body); await ctx.save(id, { gcalEventId: ev.id }); } else throw e; }
    } else {
      const ev = await gapi('POST', '/calendars/' + encodeURIComponent(CAL_ID) + '/events', body);
      await ctx.save(id, { gcalEventId: ev.id });
    }
    status.lastSync = Date.now(); status.lastError = null; invalidate(item.week);
  });
}
/** The item is being deleted: remove its event if it has one. */
function removeItem(id, item) {
  if (!ENABLED || !item || !item.gcalEventId) return Promise.resolve();
  return enqueue(id, async () => { await deleteEvent(item.gcalEventId); invalidate(item.week); status.lastSync = Date.now(); });
}
async function deleteEvent(eid) {
  try { await gapi('DELETE', '/calendars/' + encodeURIComponent(CAL_ID) + '/events/' + encodeURIComponent(eid)); }
  catch (e) { if (e.status !== 404 && e.status !== 410) throw e; }
}

/* ---------- calendar -> board ---------- */
function invalidate(week) { if (week) weekCache.delete(week); }
/** Events for the Monday-keyed week. Returns { connected, events: [{id,title,allDay,date,start,end,board,homeTeamId,location}] }. */
async function listWeek(weekKey, force) {
  if (!ENABLED) return { connected: false, events: [] };
  const c = weekCache.get(weekKey);
  if (c && !force && Date.now() - c.at < 60000) return { connected: true, events: c.events };
  const timeMin = new Date(parseKey(weekKey).getTime() - 12 * 3600e3).toISOString(), timeMax = new Date(parseKey(addDays(weekKey, 7)).getTime() + 12 * 3600e3).toISOString();
  const j = await gapi('GET', '/calendars/' + encodeURIComponent(CAL_ID) + '/events', null, { timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '250', timeZone: TZ });
  const events = (j.items || []).filter(ev => ev.status !== 'cancelled').map(ev => {
    const allDay = !!(ev.start && ev.start.date);
    const priv = (ev.extendedProperties && ev.extendedProperties.private) || {};
    let date = allDay ? ev.start.date : localDate(ev.start && ev.start.dateTime);
    return { id: ev.id, title: ev.summary || '(no title)', allDay, date, start: allDay ? null : ev.start.dateTime, end: allDay ? ev.end && ev.end.date : ev.end && ev.end.dateTime, board: !!priv.homeTeamId, homeTeamId: priv.homeTeamId || null, location: ev.location || null };
  });
  weekCache.set(weekKey, { at: Date.now(), events });
  status.lastSync = Date.now(); status.lastError = null;
  return { connected: true, events };
}
function localDate(iso) {
  if (!iso) return null;
  try { const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }); return f.format(new Date(iso)); } catch (e) { return iso.slice(0, 10); }
}

async function probe() {
  if (!ENABLED) return;
  try { const c = await gapi('GET', '/calendars/' + encodeURIComponent(CAL_ID)); status.calendarName = c.summary || null; status.lastError = null; console.log('[calendar] connected to "' + status.calendarName + '" as ' + SA.client_email); }
  catch (e) { status.lastError = e.message; console.warn('[calendar] probe failed:', e.message, '\n  -> share the calendar with ' + SA.client_email + ' (Make changes to events) and check GOOGLE_CALENDAR_ID'); }
}

module.exports = { enabled: ENABLED, status, syncItem, removeItem, listWeek, invalidate, probe, DEFAULT_AREAS, AREAS,
  _test: { eventBody, shouldHaveEvent, itemDate, setFetch: f => { fetchImpl = f; }, resetToken: () => { token = { value: null, exp: 0 }; }, serviceAccountEmail: SA && SA.client_email } };
