/* global self, fetch, indexedDB, URL, AbortController, setTimeout, clearTimeout */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Registry name of the daemon this SW's origin is, so push titles can carry
// the source daemon (add-multi-workspace-client "Notification displays source
// daemon"). The viewer caches the manifest in localStorage, which a service
// worker does not have (#171: `self.localStorage` is undefined here, so the
// prefix never appeared). Ask the gateway for the same manifest instead, with
// the bearer the viewer mirrored into IndexedDB; the owner-only route answers a
// non-owner or a single-daemon install with 403 or 404 and that is simply no
// prefix. Bounded, because a push notification must not wait on a slow
// gateway. Resolves '' on any error.
const MANIFEST_WAIT_MS = 2000;
async function originDaemonName() {
  let timer;
  try {
    const token = await idbGetToken();
    if (!token) return '';
    const ctl = new AbortController();
    timer = setTimeout(() => ctl.abort(), MANIFEST_WAIT_MS);
    const res = await fetch('/ui/clients-manifest.json', {
      headers: { Authorization: 'Bearer ' + token },
      signal: ctl.signal,
    });
    if (!res.ok) return '';
    const obj = await res.json();
    const list = obj && Array.isArray(obj.daemons) ? obj.daemons : [];
    for (const d of list) {
      if (!d || typeof d.name !== 'string' || typeof d.url !== 'string')
        continue;
      try {
        if (new URL(d.url).origin === self.location.origin) return d.name;
      } catch {
        /* malformed url entry — skip it */
      }
    }
  } catch {
    /* unreachable, refused or corrupt: no prefix */
  } finally {
    clearTimeout(timer);
  }
  return '';
}

// #190. A page left open in the background is told about the push, so it can
// ask for the request it names before the reader comes back to it (its own
// 5 s status poll pauses while it is hidden). Best effort: a worker with no
// clients API, or no page, tells nobody and still shows the notification.
async function tellPages(p) {
  if (!self.clients || typeof self.clients.matchAll !== 'function') return;
  try {
    const all = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });
    for (const c of all) {
      c.postMessage({
        type: 'rc-push',
        kind: p.kind,
        sessionId: p.sessionId,
        requestId: p.requestId,
      });
    }
  } catch {
    /* nobody to tell */
  }
}

self.addEventListener('push', (event) => {
  let p;
  try {
    p = event.data ? event.data.json() : {};
  } catch {
    p = {};
  }
  if (p.v !== 1) return;
  let title;
  if (p.kind === 'permission.required') title = 'Permission needed';
  else if (p.kind === 'session.turn_complete') title = 'Reply ready';
  else if (p.kind === 'session.turn_failed') title = 'Turn failed';
  else title = 'qwen-code';
  const actions =
    p.kind === 'permission.required'
      ? [
          { action: 'approve', title: 'Approve' },
          { action: 'deny', title: 'Deny' },
        ]
      : [];
  event.waitUntil(
    (async () => {
      // Push titles only (notification clicks are untouched): when this origin
      // is one of several registered daemons, "[workstation-1] Permission
      // needed".
      const dname = await originDaemonName();
      if (dname) title = '[' + dname + '] ' + title;
      await tellPages(p);
      await self.registration.showNotification(title, {
        body: String(p.summary || '').slice(0, 140),
        tag: p.requestId || p.sessionId || undefined,
        data: {
          url: p.url || '/ui/',
          requestId: p.requestId,
          sessionId: p.sessionId,
          kind: p.kind,
          approveOptionId: p.approveOptionId,
        },
        actions,
      });
    })(),
  );
});

// Best-effort read of the bearer token mirrored into IndexedDB by the viewer
// (DB qwen-rc v1, store auth, key token). Resolves undefined on any error so
// voting silently falls back to opening the app.
function idbGetToken() {
  return new Promise((resolve) => {
    try {
      if (!('indexedDB' in self)) return resolve(undefined);
      const req = indexedDB.open('qwen-rc', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('auth')) {
          db.createObjectStore('auth');
        }
      };
      req.onerror = () => resolve(undefined);
      req.onsuccess = () => {
        try {
          const db = req.result;
          if (!db.objectStoreNames.contains('auth')) return resolve(undefined);
          const tx = db.transaction('auth', 'readonly');
          const get = tx.objectStore('auth').get('token');
          get.onsuccess = () =>
            resolve(typeof get.result === 'string' ? get.result : undefined);
          get.onerror = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      };
    } catch {
      resolve(undefined);
    }
  });
}

// POST a vote to the cycle-6 permission endpoint. Resolves undefined on any
// network/error so the caller can fall back to opening the app.
async function postVote(sessionId, requestId, body, token) {
  try {
    return await fetch(
      '/session/' +
        encodeURIComponent(sessionId) +
        '/permission/' +
        encodeURIComponent(requestId),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
        },
        body: JSON.stringify(body),
      },
    );
  } catch {
    return undefined;
  }
}

// Brief confirmation notification, reusing the request tag so it replaces the
// original notification rather than stacking.
function confirmNote(text, tag) {
  return self.registration.showNotification(text, {
    tag: tag || undefined,
  });
}

// Focus an existing window at the deep link, or open a new one.
async function openApp(url) {
  const all = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });
  for (const c of all) {
    if ('focus' in c) {
      c.navigate?.(url);
      return c.focus();
    }
  }
  return self.clients.openWindow(url);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  const isVote = event.action === 'approve' || event.action === 'deny';
  if (isVote && d.requestId && d.sessionId) {
    event.waitUntil(
      (async () => {
        const token = await idbGetToken();
        const body =
          event.action === 'approve'
            ? d.approveOptionId
              ? { outcome: 'selected', optionId: d.approveOptionId }
              : null
            : { outcome: 'cancelled' };
        if (token && body) {
          const res = await postVote(d.sessionId, d.requestId, body, token);
          if (res && res.ok) {
            await confirmNote(
              event.action === 'approve' ? 'Approved' : 'Denied',
              d.requestId,
            );
            return;
          }
          if (res && res.status === 404) {
            await confirmNote('Already resolved', d.requestId);
            return;
          }
        }
        // fall through: open the app so the user can act manually
        await openApp(d.url || '/ui/');
      })(),
    );
    return;
  }
  event.waitUntil(openApp(d.url || '/ui/'));
});
