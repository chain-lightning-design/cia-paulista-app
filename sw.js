/* Cia Paulista — member-app service worker.
 *
 * Scope discipline: registered only by member-app.html, but a root-scope SW still
 * SEES every request on the origin — including shared files (data.js, vendor/*,
 * favicon, icons) that the hub and the other eight apps also load. So handling is
 * gated TWICE:
 *   1. an explicit asset whitelist (below), and
 *   2. member-app CONTEXT: a request is respondWith'd only when it IS the member
 *      app shell / manifest (matched by URL), or its referrer resolves to
 *      member-app.html. Same-origin subresource requests carry the full document
 *      URL as referrer under the default referrer policy, so data.js requested BY
 *      member-app.html is served from cache, while the identical data.js request
 *      from owner-console.html (referrer owner-console.html) passes through to
 *      the network untouched — the other apps never see a stale copy from us.
 *
 * Strategy: stale-while-revalidate. Cached copy answers instantly (offline-proof
 * member card / QR); a background refetch keeps the cache current. Cache keys are
 * query-stripped so claim links (member-app.html?m=<token>) hit the cached shell.
 *
 * Versioning: bump CACHE on breaking asset changes; activate deletes old
 * cp-member-* caches and claims open clients. v2: context gating added — the
 * bump makes existing pilot devices drop the old overbroad v1 cache. v3:
 * member-app gained env.js as its FIRST script — an offline device on a v2
 * cache would serve the shell but 404 env.js, so CP.env would be undefined and
 * data.js/onboarding.js would branch on nothing. The bump re-precaches it.
 */
'use strict';

var CACHE = 'cp-member-v3';

// The whitelist. Must mirror the <script src> tags in member-app.html exactly,
// plus the app shell, manifest, favicon and PWA icons (deploy_live_site.py
// flattens prototypes/ to the site root, so these relative paths hold on the
// live site: sw.js sits next to member-app.html).
var ASSETS = [
  'member-app.html',
  'member-app.webmanifest',
  'env.js',        // FIRST script in the app: CP.env must exist offline too
  'data.js',
  'onboarding.js',
  'vendor/tailwind.js',
  'vendor/qrcode.js',
  'vendor/supabase.js',
  'favicon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-180.png',
];

// Absolute URLs of the whitelist, resolved against this SW's location (site root).
var URLS = ASSETS.map(function (p) { return new URL(p, self.location.href).href; });
var URLSET = {};
URLS.forEach(function (u) { URLSET[u] = true; });

function keyOf(url) { return String(url).split('#')[0].split('?')[0]; }

// Member-app contexts (query-stripped): the app shell and its manifest.
var APP_URL = keyOf(new URL('member-app.html', self.location.href).href);
var MAN_URL = keyOf(new URL('member-app.webmanifest', self.location.href).href);

// True only for requests that belong to the member app:
//  - the shell / manifest themselves, matched by URL (a navigation's referrer is
//    the previous page or empty, never the app — so URL is the reliable signal;
//    the manifest also matches by URL as belt-and-braces, though its referrer is
//    member-app.html anyway);
//  - any other whitelisted asset ONLY when its referrer resolves to
//    member-app.html (claim links referrer member-app.html?m=… — query-stripped).
// Everything else (same asset, different page; empty referrer on a shared icon)
// fails open to the network.
function isMemberAppContext(request, key) {
  if (key === APP_URL || key === MAN_URL) return true;
  return keyOf(request.referrer || '') === APP_URL;
}

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // Resilient precache: one flaky asset must not fail the whole install —
      // anything missed is picked up by the first stale-while-revalidate pass.
      return Promise.all(URLS.map(function (u) {
        return fetch(u).then(function (r) {
          if (r && r.ok) return c.put(u, r);
        }).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (n) {
        // Only our own namespace — never touch caches another app may own.
        if (n.indexOf('cp-member-') === 0 && n !== CACHE) return caches.delete(n);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var key = keyOf(e.request.url);
  if (!URLSET[key]) return; // NOT whitelisted -> pass through untouched
  if (!isMemberAppContext(e.request, key)) return; // another app's request -> untouched
  e.respondWith(
    caches.open(CACHE).then(function (c) {
      return c.match(key).then(function (hit) {
        var refetch = fetch(e.request).then(function (resp) {
          if (resp && resp.ok) {
            var copy = resp.clone();
            c.put(key, copy);
          }
          return resp;
        });
        if (hit) {
          // Serve stale now, revalidate in the background.
          e.waitUntil(refetch.catch(function () {}));
          return hit;
        }
        return refetch.catch(function () {
          return new Response('Offline', { status: 503, statusText: 'Offline' });
        });
      });
    })
  );
});
