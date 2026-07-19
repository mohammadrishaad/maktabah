/* Maktabah service worker: receives PDFs shared from other apps (Web Share Target) */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

function openShareDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('mk-share', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files', { autoIncrement: true });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      try {
        const form = await e.request.formData();
        const files = form.getAll('pdfs').filter((f) => f && f.size);
        if (files.length) {
          const db = await openShareDB();
          await new Promise((res, rej) => {
            const tx = db.transaction('files', 'readwrite');
            files.forEach((f) => tx.objectStore('files').add(f));
            tx.oncomplete = res;
            tx.onerror = () => rej(tx.error);
          });
        }
      } catch (err) { /* fall through to the app either way */ }
      return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
    })());
  }
});
