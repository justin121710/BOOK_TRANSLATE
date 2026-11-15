import { del, get, open, putMany, uid } from './db.js';

const PENDING = 'searchable:pending';
const OUTPUT = 'searchable:output';
const LOCK = 'book-translate-searchable';

export const changes = new EventTarget();
export const job = { loading: true, controller: null, pending: null, output: null, message: '' };
let restoration;

function notify() {
  changes.dispatchEvent(new Event('change'));
}

function pagePrefix(id) {
  return 'searchable:ocr:' + id + ':';
}

async function clearPending(id, output) {
  const db = await open();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('meta', 'readwrite');
    const store = tx.objectStore('meta');
    let conflict = false;
    const pending = store.get(PENDING);
    pending.onsuccess = () => {
      if (pending.result?.id !== id) {
        conflict = true;
        tx.abort();
        return;
      }
      store.delete(PENDING);
      const prefix = pagePrefix(id);
      const cursor = store.openKeyCursor(IDBKeyRange.bound(prefix, prefix + '\uffff'));
      cursor.onsuccess = () => {
        if (!cursor.result) {
          if (output) store.put({ key: OUTPUT, ...output });
          return;
        }
        store.delete(cursor.result.primaryKey);
        cursor.result.continue();
      };
    };
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || new Error(conflict ? '未完成的工作已在其他分頁變更' : '儲存中止'));
  });
}

export function restoreJob() {
  return restoration ??= loadJob();
}

async function loadJob() {
  try {
    const [pending, output] = await Promise.all([get('meta', PENDING), get('meta', OUTPUT)]);
    job.pending = pending ?? null;
    job.output = output ?? null;
    if (pending) job.message = '有未完成的 PDF。繼續處理時會沿用已儲存的 OCR 結果。';
  } catch (error) {
    job.message = '無法讀取本機儲存：' + error.message;
  } finally {
    job.loading = false;
    notify();
  }
}

async function exclusively(action) {
  if (job.loading || job.controller) return;
  const controller = new AbortController();
  job.controller = controller;
  notify();
  try {
    if (navigator.locks) {
      await navigator.locks.request(LOCK, { ifAvailable: true }, async lock => {
        if (!lock) throw new Error('另一個分頁正在處理 PDF，請回到該分頁');
        await action(controller.signal);
      });
    } else {
      await action(controller.signal);
    }
  } catch (error) {
    job.message = controller.signal.aborted
      ? '已停止。已儲存的 OCR 進度可繼續使用。'
      : '處理失敗：' + error.message;
  } finally {
    job.controller = null;
    notify();
  }
}

export function runJob(file, options) {
  return exclusively(async signal => {
    job.pending = await get('meta', PENDING) ?? null;
    if (file && job.pending) throw new Error('請先繼續或捨棄未完成的 PDF');
    if (file) {
      const pending = { key: PENDING, id: uid(), file, options };
      job.message = '正在儲存原始 PDF…';
      notify();
      await putMany('meta', [pending]);
      job.pending = pending;
    }
    if (!job.pending) return;
    signal.throwIfAborted();
    job.message = '正在開啟 PDF…';
    notify();

    const pending = job.pending;
    const prefix = pagePrefix(pending.id);
    const { makeSearchablePdf } = await import('../pdf/searchable.js');
    const checkpoint = {
      load: async number => (await get('meta', prefix + number))?.ocr,
      save: rows => putMany('meta', rows.map(({ number, ocr }) => ({ key: prefix + number, ocr }))),
    };
    const baseName = pending.file.name.replace(/\.pdf$/i, '');
    let parts = pending.parts ?? [];
    let last = parts.at(-1);
    while (!last || last.range.to < last.range.total) {
      signal.throwIfAborted();
      const from = (last?.range.to ?? 0) + 1;
      const result = await makeSearchablePdf(pending.file, {
        ...pending.options,
        signal, checkpoint, from, splitLarge: true,
        onProgress: (page, total, batch) => {
          if (batch) {
            const range = page === batch.last ? page : `${page}–${batch.last}`;
            job.message = `正在辨識第 ${range} 頁（這批 ${batch.count} 張，共 ${total} 頁）…`;
          } else {
            job.message = page ? `正在準備第 ${page}／${total} 頁…` : `正在輸出第 ${from} 頁起的 PDF…`;
          }
          notify();
        },
      });
      const { range } = result;
      const suffix = range.from === 1 && range.to === range.total ? '' : `_${range.from}-${range.to}`;
      last = { name: baseName + '_可搜尋' + suffix + '.pdf', result, range };
      parts = [...parts, last];
      job.message = '正在儲存 PDF…';
      notify();
      const updated = { ...pending, parts };
      try {
        await putMany('meta', [updated]);
      } catch (error) {
        job.pending = updated;
        job.message = '已產生的 PDF 無法寫入儲存空間，請先下載：' + error.message;
        return;
      }
      job.pending = updated;
      notify();
    }

    const output = { parts, options: pending.options };
    job.message = '正在儲存完成的 PDF…';
    notify();
    try {
      await clearPending(pending.id, output);
      job.pending = null;
      job.message = '處理完成。';
    } catch (error) {
      job.message = 'PDF 已產生，但無法儲存副本。請先下載：' + error.message;
    }
    job.output = output;
  });
}

export function discardJob() {
  return exclusively(async () => {
    const pending = await get('meta', PENDING);
    if (pending) await clearPending(pending.id);
    job.pending = null;
    job.message = '已捨棄未完成的工作。';
  });
}

export function deleteOutput() {
  return exclusively(async () => {
    await del('meta', OUTPUT);
    job.output = null;
    job.message = '已移除儲存的成品。';
  });
}
