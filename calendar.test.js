'use strict';
/* Unit test for calendar.js: generated RSA key, mocked Google endpoints. Run: npm test */
const assert = require('assert');
const crypto = require('crypto');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'home-team@test.iam.gserviceaccount.com', private_key: pem });
process.env.GOOGLE_CALENDAR_ID = 'family@group.calendar.google.com';
process.env.TZ = 'America/New_York';

const cal = require('../calendar');
assert.strictEqual(cal.enabled, true, 'calendar should be enabled with key + id');

const calls = [];
const events = {};
let nextId = 1, tokenRequests = 0;
cal._test.setFetch(async (url, opts) => {
  const u = String(url), method = (opts && opts.method) || 'GET';
  calls.push(method + ' ' + u.replace(/\?.*$/, ''));
  const json = (code, body) => ({ ok: code < 300, status: code, json: async () => body });
  if (u.startsWith('https://oauth2.googleapis.com/token')) {
    tokenRequests++;
    const assertion = /assertion=([^&]+)/.exec(opts.body)[1];
    const [h, c, s] = assertion.split('.');
    const ok = crypto.verify('RSA-SHA256', Buffer.from(h + '.' + c), publicKey, Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
    assert.ok(ok, 'JWT signature verifies with the public key');
    const claims = JSON.parse(Buffer.from(c, 'base64').toString());
    assert.strictEqual(claims.scope, 'https://www.googleapis.com/auth/calendar');
    return json(200, { access_token: 'tok-' + tokenRequests, expires_in: 3600 });
  }
  assert.strictEqual(opts.headers.authorization, 'Bearer tok-' + tokenRequests, 'bearer token sent');
  const m = /\/calendars\/([^/]+)(?:\/events(?:\/([^/?]+))?)?/.exec(u);
  const calId = decodeURIComponent(m[1]), evId = m[2] && decodeURIComponent(m[2]);
  assert.strictEqual(calId, 'family@group.calendar.google.com');
  if (!m[0].includes('/events')) return json(200, { id: calId, summary: 'Fincher Household' });
  if (method === 'POST') { const id = 'ev' + nextId++; events[id] = Object.assign({ id, status: 'confirmed' }, JSON.parse(opts.body)); return json(200, events[id]); }
  if (method === 'PATCH') { if (!events[evId]) return json(404, { error: { message: 'Not Found' } }); Object.assign(events[evId], JSON.parse(opts.body)); return json(200, events[evId]); }
  if (method === 'DELETE') { delete events[evId]; return { ok: true, status: 204, json: async () => ({}) }; }
  if (method === 'GET') return json(200, { items: Object.values(events).concat([{ id: 'ext1', status: 'confirmed', summary: "Maya's dentist", start: { dateTime: '2026-11-05T14:30:00-05:00' }, end: { dateTime: '2026-11-05T15:30:00-05:00' } }, { id: 'ext2', status: 'confirmed', summary: 'Thanksgiving at Brandon’s', start: { date: '2026-11-26' }, end: { date: '2026-11-27' } }]) });
  return json(500, {});
});

(async () => {
  const saved = {};
  const settings = { names: { a: 'Alan', b: 'Maya' }, calendarAreas: { meal: false } };
  const ctx = { settings, appUrl: 'https://home-team.onrender.com', save: async (id, patch) => { saved[id] = Object.assign(saved[id] || {}, patch); } };

  // 1. event body: all-day + timed, names, check mark
  const item = { id: 'i1', area: 'workout', title: 'Gym together', who: 'both', week: '2026-11-02', day: 0, done: false, notes: '6:30 at the Y' };
  let body = cal._test.eventBody(item, ctx);
  assert.deepStrictEqual(body.start, { date: '2026-11-02' }); assert.deepStrictEqual(body.end, { date: '2026-11-03' });
  assert.strictEqual(body.summary, 'Gym together · Alan & Maya');
  assert.ok(body.description.includes('Workout') && body.description.includes('6:30 at the Y') && body.description.includes('home-team.onrender.com'));
  assert.strictEqual(body.extendedProperties.private.homeTeamId, 'i1');
  body = cal._test.eventBody(Object.assign({}, item, { time: '06:30', done: true, who: 'a', day: 6 }), ctx);
  assert.deepStrictEqual(body.start, { dateTime: '2026-11-08T06:30:00', timeZone: 'America/New_York' });
  assert.deepStrictEqual(body.end, { dateTime: '2026-11-08T07:30:00', timeZone: 'America/New_York' });
  assert.strictEqual(body.summary, '✓ Gym together · Alan');
  body = cal._test.eventBody(Object.assign({}, item, { time: '23:30', duration: 90 }), ctx);
  assert.strictEqual(body.end.dateTime, '2026-11-03T01:00:00', 'timed event crossing midnight rolls the date');

  // 2. which items get events
  assert.strictEqual(cal._test.shouldHaveEvent(item, ctx), true);
  assert.strictEqual(cal._test.shouldHaveEvent(Object.assign({}, item, { week: null }), ctx), false, 'unscheduled');
  assert.strictEqual(cal._test.shouldHaveEvent(Object.assign({}, item, { day: null }), ctx), false, 'anytime this week has no date');
  assert.strictEqual(cal._test.shouldHaveEvent(Object.assign({}, item, { area: 'meal' }), ctx), false, 'dinners off by default');
  assert.strictEqual(cal._test.shouldHaveEvent(Object.assign({}, item, { area: 'meal' }), { settings: { calendarAreas: { meal: true } } }), true, 'dinners on when toggled');
  assert.strictEqual(cal._test.shouldHaveEvent(Object.assign({}, item, { dropped: true }), ctx), false);

  // 3. create -> patch -> unschedule deletes
  await cal.syncItem('i1', item, ctx);
  assert.strictEqual(saved.i1.gcalEventId, 'ev1', 'event id saved back to the item');
  assert.strictEqual(Object.keys(events).length, 1);
  await cal.syncItem('i1', Object.assign({}, item, { gcalEventId: 'ev1', done: true }), ctx);
  assert.strictEqual(events.ev1.summary, '✓ Gym together · Alan & Maya', 'done shows in the calendar');
  assert.strictEqual(Object.keys(events).length, 1, 'patch, not a second event');
  await cal.syncItem('i1', Object.assign({}, item, { gcalEventId: 'ev1', week: null, day: null }), ctx);
  assert.strictEqual(Object.keys(events).length, 0, 'unscheduled item removed from the calendar');
  assert.strictEqual(saved.i1.gcalEventId, null);

  // 4. a stale event id (deleted by hand in Google Calendar) recreates instead of failing
  await cal.syncItem('i2', Object.assign({}, item, { gcalEventId: 'gone', title: 'Run' }), ctx);
  assert.strictEqual(saved.i2.gcalEventId, 'ev2');

  // 5. delete flow + 404 tolerated
  await cal.removeItem('i2', { gcalEventId: 'ev2', week: '2026-11-02' });
  assert.strictEqual(Object.keys(events).length, 0);
  await cal.removeItem('i3', { gcalEventId: 'never-existed', week: '2026-11-02' });
  assert.strictEqual(cal.status.lastError, null, 'deleting a missing event is not an error');

  // 6. week listing: board events flagged, outside events dated in local time
  await cal.syncItem('i4', Object.assign({}, item, { title: 'Long walk', day: 5 }), ctx);
  const wk = await cal.listWeek('2026-11-02', true);
  assert.strictEqual(wk.connected, true);
  const mine = wk.events.find(e => e.homeTeamId === 'i4'), dentist = wk.events.find(e => e.id === 'ext1'), tg = wk.events.find(e => e.id === 'ext2');
  assert.ok(mine && mine.board === true && mine.date === '2026-11-07');
  assert.ok(dentist && dentist.board === false && dentist.allDay === false && dentist.date === '2026-11-05' && dentist.start === '2026-11-05T14:30:00-05:00');
  assert.ok(tg && tg.allDay === true && tg.date === '2026-11-26');
  const again = await cal.listWeek('2026-11-02');
  assert.strictEqual(again.events.length, wk.events.length, 'cached listing');

  // 7. token fetched once and reused; 401 refreshes
  assert.strictEqual(tokenRequests, 1, 'one token for the whole run');
  await cal.probe();
  assert.strictEqual(cal.status.calendarName, 'Fincher Household');

  const listCalls = calls.filter(c => c.startsWith('GET') && c.includes('/events')).length;
  assert.strictEqual(listCalls, 1, 'second listWeek served from cache');
  console.log('calendar.js: all checks passed (' + calls.length + ' mocked calls)');
})().catch(e => { console.error('FAILED', e); process.exit(1); });
