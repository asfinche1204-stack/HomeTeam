/* Home Team service worker: caches the app shell so the board opens instantly and
   shows the last copy offline; API calls always go to the network; shows push
   notifications. Bump CACHE on shell changes; index.html is network-first. */
const CACHE = 'home-team-v13';
const SHELL = ['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png', '/icon-180.png', '/og.png'];

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (url.pathname === '/' || url.pathname === '/index.html') {
    e.respondWith(fetch(e.request, { cache: 'no-store' }).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request).then(r => r || caches.match('/'))));
    return;
  }
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res; })));
});
self.addEventListener('message', e => { if (e.data === 'skip-waiting') self.skipWaiting(); });
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: 'Home Team', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Home Team', { body: d.body || '', icon: d.icon || '/icon-192.png', badge: d.badge || '/icon-192.png', tag: d.tag || 'home-team', renotify: true, data: { url: d.url || '/', hf: d.hf || null } }));
});
/* A "just finished" notification carries hf = { itemId, who, to, title }: tapping it sends the
   high five straight from here (same id the app uses, so it can never double up), then opens the feed. */
function sendHighFive(hf) {
  if (!hf || !hf.itemId || !hf.who) return Promise.resolve(false);
  const id = 'hf-' + hf.itemId + '-' + hf.who;
  return fetch('/api/doc/feed/' + encodeURIComponent(id), { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'highfive', who: hf.who, to: hf.to, title: hf.title || '', itemId: hf.itemId, at: Date.now() }) }).then(r => r.ok).catch(() => false);
}
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const data = e.notification.data || {};
  let url = data.url || '/';
  e.waitUntil(sendHighFive(data.hf).then(sent => {
    if (data.hf) url = '/#hf-' + (sent ? 'sent' : 'retry') + '/' + encodeURIComponent(data.hf.itemId) + '/' + data.hf.to;
    return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  }).then(list => {
    for (const c of list) { if ('focus' in c) { c.postMessage({ t: 'open', url }); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
