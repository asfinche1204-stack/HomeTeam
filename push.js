'use strict';
/*
 * push.js — phone notifications for Home Team (Web Push, works on iPhone once the app is on the Home Screen).
 * Env (all three, or push stays off):
 *   HT_VAPID_PUBLIC, HT_VAPID_PRIVATE   generate once: node server.js --vapid
 *   HT_PUSH_SUBJECT                     mailto:you@example.com
 * What gets sent (each person can switch these off in Settings):
 *   partner  "Maya finished Full body B (+10)"   when the other person checks something off
 *   nudge    a line the other person chose for you, on an open item
 *   highfive the other person high-fived your check-off
 *   evening  7:00 pm local: what's still open on your board today
 *   sunday   6:00 pm Sunday: plan the week together
 */
let webpush = null;
try { webpush = require('web-push'); } catch (e) { webpush = null; }

const PUB = (process.env.HT_VAPID_PUBLIC || '').trim(), PRIV = (process.env.HT_VAPID_PRIVATE || '').trim(), SUBJECT = (process.env.HT_PUSH_SUBJECT || '').trim();
const ENABLED = !!(webpush && PUB && PRIV && SUBJECT);
if (ENABLED) webpush.setVapidDetails(SUBJECT, PUB, PRIV);
else if (webpush && (PUB || PRIV)) console.warn('[push] set all of HT_VAPID_PUBLIC, HT_VAPID_PRIVATE and HT_PUSH_SUBJECT to turn notifications on');

const status = { enabled: ENABLED, publicKey: ENABLED ? PUB : null, sent: 0, lastError: null };

function generateVapid() {
  if (!webpush) { console.log('web-push is not installed: run npm install first'); return; }
  const k = webpush.generateVAPIDKeys();
  console.log('\nAdd these to the Render service:\n\n  HT_VAPID_PUBLIC=' + k.publicKey + '\n  HT_VAPID_PRIVATE=' + k.privateKey + '\n  HT_PUSH_SUBJECT=mailto:you@example.com\n');
}

/**
 * Send one notification to every phone registered to `person` ('a' | 'b').
 * subs: the push collection {id: {person, sub}}; onDead(id) is called for subscriptions the browser has dropped.
 */
async function sendTo(person, payload, subs, onDead) {
  if (!ENABLED) return 0;
  const body = JSON.stringify(Object.assign({ icon: '/icon-192.png', badge: '/icon-192.png' }, payload));
  let n = 0;
  for (const [id, rec] of Object.entries(subs)) {
    if (!rec || rec.person !== person || !rec.sub) continue;
    try { await webpush.sendNotification(rec.sub, body, { TTL: 6 * 3600 }); n++; status.sent++; }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) { if (onDead) await onDead(id); } else { status.lastError = e.message; console.warn('[push]', e.statusCode || '', e.message); } }
  }
  return n;
}

/** Local wall-clock parts in TZ for the scheduler. */
function localNow(tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const p = {}; f.formatToParts(new Date()).forEach(x => { p[x.type] = x.value; });
  const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday);
  return { date: p.year + '-' + p.month + '-' + p.day, hour: Number(p.hour) % 24, minute: Number(p.minute), dow };
}

module.exports = { enabled: ENABLED, status, sendTo, generateVapid, localNow };
