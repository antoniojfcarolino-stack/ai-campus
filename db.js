/* IndexedDB: biblioteca (ficheiros + excertos), conversas, baralho e a cache local (respostas, fontes, rotas). Tudo fica no telemóvel. */
const DB = (() => {
  const STORES = ['files', 'chunks', 'chats', 'cards', 'cache'];
  let dbp;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('ai-campus', 3);
    r.onupgradeneeded = () => { // seguro para quem já tinha as versões 1 e 2
      const d = r.result;
      if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'id' }).createIndex('uc', 'uc');
      if (!d.objectStoreNames.contains('chunks')) {
        const c = d.createObjectStore('chunks', { keyPath: 'id' });
        c.createIndex('uc', 'uc'); c.createIndex('fileId', 'fileId');
      }
      if (!d.objectStoreNames.contains('chats')) d.createObjectStore('chats', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('cards')) d.createObjectStore('cards', { keyPath: 'id' }).createIndex('uc', 'uc');
      if (!d.objectStoreNames.contains('cache')) d.createObjectStore('cache', { keyPath: 'k' });
    };
    // Uma versão nova da app noutro separador precisa de atualizar a base: este fecha a ligação em vez de a bloquear.
    r.onsuccess = () => { const d = r.result; d.onversionchange = () => { d.close(); dbp = null; }; res(d); };
    r.onerror = () => rej(r.error);
  }));
  const tx = async (stores, mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(stores, mode);
      const req = fn(t);
      t.oncomplete = () => res(req && 'result' in req ? req.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  };
  return {
    put: (s, v) => tx(s, 'readwrite', t => t.objectStore(s).put(v)),
    putMany: (s, arr) => tx(s, 'readwrite', t => { const o = t.objectStore(s); arr.forEach(v => o.put(v)); }),
    get: (s, k) => tx(s, 'readonly', t => t.objectStore(s).get(k)),
    del: (s, k) => tx(s, 'readwrite', t => t.objectStore(s).delete(k)),
    delMany: (s, ks) => tx(s, 'readwrite', t => { const o = t.objectStore(s); ks.forEach(k => o.delete(k)); }),
    all: s => tx(s, 'readonly', t => t.objectStore(s).getAll()),
    count: s => tx(s, 'readonly', t => t.objectStore(s).count()),
    clear: s => tx(s, 'readwrite', t => t.objectStore(s).clear()),
    byIndex: (s, idx, v) => tx(s, 'readonly', t => t.objectStore(s).index(idx).getAll(v)),
    delByIndex: (s, idx, v) => tx(s, 'readwrite', t => {
      const o = t.objectStore(s), req = o.index(idx).openKeyCursor(IDBKeyRange.only(v));
      req.onsuccess = () => { const c = req.result; if (c) { o.delete(c.primaryKey); c.continue(); } };
    }),
    clearAll: () => tx(STORES, 'readwrite', t => STORES.forEach(s => t.objectStore(s).clear())),
  };
})();
