/* Service worker: a app abre offline (a IA precisa de internet).
   Ficheiros da app: rede primeiro (as atualizações chegam logo), com cache de reserva.
   Bibliotecas do cdnjs (versões fixas): cache primeiro. */
const CACHE = 'ai-campus-v10';   // muda a cada versão: a nova instala-se e a antiga é apagada
const LOCAL = ['./', 'index.html', 'style.css', 'core.js', 'db.js', 'app.js', 'py-worker.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
const CDN = [
  'https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.11/katex.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.6/purify.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.11/katex.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
];
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(LOCAL);
    await Promise.allSettled(CDN.map(u => c.add(u)));
    self.skipWaiting();
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  // Pyodide (Python no telemóvel): versão fixa no jsDelivr, guardada da primeira vez para os cálculos funcionarem offline
  const local = u.origin === location.origin, cdn = u.hostname === 'cdnjs.cloudflare.com' || (u.hostname === 'cdn.jsdelivr.net' && u.pathname.startsWith('/pyodide/'));
  if (e.request.method !== 'GET' || !(local || cdn)) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    if (cdn) {
      const hit = await c.match(e.request);
      if (hit) return hit;
      try { const r = await fetch(e.request); if (r.ok || r.type === 'opaque') c.put(e.request, r.clone()); return r; }
      catch (err) { return new Response('offline', { status: 503 }); }
    }
    try {
      const r = await withTimeout(fetch(e.request), 4000);
      if (r.ok) c.put(e.request, r.clone());
      return r;
    } catch (err) {
      return (await c.match(e.request, { ignoreSearch: true })) || (await c.match('index.html')) || new Response('offline', { status: 503 });
    }
  })());
});
