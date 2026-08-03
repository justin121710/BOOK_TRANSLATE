/* IndexedDB — 所有重的東西都放這裡：頁面影像、OCR 結果、譯文、詞彙表、字型。
   localStorage 只放金鑰與偏好設定。
   刻意不引入外部套件，這層只有幾十行 promise 包裝。 */

const DB_NAME = 'book_translate';
const DB_VERSION = 1;

/** @type {Promise<IDBDatabase>|null} */
let dbp = null;

export function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (ev) => {
      const db = req.result;
      const tx = req.transaction;

      if (ev.oldVersion < 1) {
        // 一本書
        const projects = db.createObjectStore('projects', { keyPath: 'id' });
        projects.createIndex('updatedAt', 'updatedAt');

        // 一頁：原始影像 + 校正後影像 + 四角座標
        const pages = db.createObjectStore('pages', { keyPath: 'id' });
        pages.createIndex('projectId', 'projectId');
        pages.createIndex('byProjectIndex', ['projectId', 'index']);

        // 一個文字塊：OCR 座標 + 原文 + 譯文 + 分類
        const blocks = db.createObjectStore('blocks', { keyPath: 'id' });
        blocks.createIndex('pageId', 'pageId');
        blocks.createIndex('projectId', 'projectId');
        blocks.createIndex('byPageOrder', ['pageId', 'order']);

        // 一個圖片區域
        const figures = db.createObjectStore('figures', { keyPath: 'id' });
        figures.createIndex('pageId', 'pageId');
        figures.createIndex('projectId', 'projectId');

        // 全書專有名詞對照，跨頁統一譯法
        const glossary = db.createObjectStore('glossary', { keyPath: 'id' });
        glossary.createIndex('projectId', 'projectId');
        glossary.createIndex('byProjectJa', ['projectId', 'ja'], { unique: true });

        // 字型二進位快取，key 為字型代號
        db.createObjectStore('fonts', { keyPath: 'id' });

        // 雜項 key/value
        db.createObjectStore('meta', { keyPath: 'key' });
      }

      tx.onerror = () => reject(tx.error);
    };

    req.onsuccess = () => {
      const db = req.result;
      // 另一個分頁升級 schema 時要讓路，否則對方會卡住
      db.onversionchange = () => { db.close(); dbp = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('資料庫被另一個分頁佔用，請關掉其他分頁再試'));
  });
  return dbp;
}

function run(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('交易中止'));
    if (req) {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } else {
      tx.oncomplete = () => resolve();
    }
  }));
}

export const get     = (store, key)  => run(store, 'readonly',  s => s.get(key));
export const getAll  = (store)       => run(store, 'readonly',  s => s.getAll());
export const put     = (store, val)  => run(store, 'readwrite', s => s.put(val));
export const del     = (store, key)  => run(store, 'readwrite', s => s.delete(key));
export const clear   = (store)       => run(store, 'readwrite', s => s.clear());

export const getBy = (store, index, value) =>
  run(store, 'readonly', s => s.index(index).getAll(value));

export function putMany(store, values) {
  return open().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    for (const v of values) os.put(v);
    tx.oncomplete = () => resolve(values.length);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('交易中止'));
  }));
}

/** 刪掉某索引下的所有列。用在刪除一本書時清乾淨附屬資料。 */
export function delBy(store, index, value) {
  return open().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).index(index).openKeyCursor(IDBKeyRange.only(value));
    let n = 0;
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return;
      tx.objectStore(store).delete(cur.primaryKey);
      n++;
      cur.continue();
    };
    tx.oncomplete = () => resolve(n);
    tx.onerror = () => reject(tx.error);
  }));
}

export function uid(prefix = '') {
  return prefix + Date.now().toString(36) + '-' +
         Math.random().toString(36).slice(2, 8);
}

/* ---------- 專案層級的組合操作 ---------- */

export async function listProjects() {
  const rows = await getAll('projects');
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function createProject(name) {
  const now = Date.now();
  const p = {
    id: uid('p_'),
    name: name || '未命名書籍',
    createdAt: now,
    updatedAt: now,
    // 每本書可覆寫的排版偏好；null 代表沿用全域設定
    layout: { vertical: null, bodyFont: 'serif', titleFont: 'sans' },
  };
  await put('projects', p);
  return p;
}

export async function touchProject(id) {
  const p = await get('projects', id);
  if (!p) return;
  p.updatedAt = Date.now();
  await put('projects', p);
}

export async function deleteProject(id) {
  for (const store of ['pages', 'blocks', 'figures', 'glossary']) {
    await delBy(store, 'projectId', id);
  }
  await del('projects', id);
}

export async function pageCount(projectId) {
  const pages = await getBy('pages', 'projectId', projectId);
  return pages.length;
}

/** 回傳這本書每個狀態各有幾頁，給列表卡片顯示進度用。 */
export async function projectStats(projectId) {
  const pages = await getBy('pages', 'projectId', projectId);
  const by = { pending: 0, ocr: 0, translated: 0, done: 0, failed: 0 };
  for (const pg of pages) by[pg.status] = (by[pg.status] || 0) + 1;
  return { total: pages.length, by };
}

/** 目前佔用的儲存空間，用於設定頁顯示。瀏覽器給的是估計值。 */
export async function estimateUsage() {
  if (!navigator.storage?.estimate) return null;
  const { usage, quota } = await navigator.storage.estimate();
  return { usage, quota };
}

export async function wipeAll() {
  for (const store of ['projects', 'pages', 'blocks', 'figures', 'glossary', 'meta']) {
    await clear(store);
  }
  // 字型刻意保留：重下載很花時間，而且不含使用者資料
}
