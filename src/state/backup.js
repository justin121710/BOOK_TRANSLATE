/* 備份與還原。
 *
 * IndexedDB 會存，但不是可靠的保存：iOS Safari 對「網頁」形式的站台有
 * 七天未使用就清除的規則（加到主畫面的 PWA 可豁免），使用者清除網站資料、
 * 刪掉主畫面圖示、或裝置空間不足時，資料也可能消失。換手機更不會跟著走。
 *
 * 所以要有一個能拿出去、放得住的檔案。
 * 用 zip 而不是單一 JSON：頁面影像佔了絕大部分體積，
 * 塞進 JSON 得先 base64，體積會多三成，而且大檔案在手機上很容易爆記憶體。
 */

import JSZip from 'jszip';
import * as db from './db.js';

const FORMAT = 1;

/**
 * 把一本書打包成 zip。
 * @param {string} projectId
 * @param {{onProgress?: (done:number,total:number)=>void}} opts
 */
export async function exportProject(projectId, opts = {}) {
  const project = await db.get('projects', projectId);
  if (!project) throw new Error('找不到這本書');

  const pages = (await db.getBy('pages', 'projectId', projectId))
    .sort((a, b) => a.index - b.index);
  const blocks = await db.getBy('blocks', 'projectId', projectId);
  const figures = await db.getBy('figures', 'projectId', projectId);
  const glossary = await db.getBy('glossary', 'projectId', projectId);

  const zip = new JSZip();
  const images = zip.folder('images');

  // 影像另外放，metadata 裡只留檔名參照
  const pageMeta = [];
  let done = 0;
  for (const p of pages) {
    const { origBlob, procBlob, ...rest } = p;
    const meta = { ...rest };

    if (origBlob) {
      meta.origFile = `${p.id}-orig.jpg`;
      images.file(meta.origFile, origBlob);
    }
    // 校正後的影像若和原圖是同一個物件就不必存兩份
    if (procBlob && procBlob !== origBlob) {
      meta.procFile = `${p.id}-proc.jpg`;
      images.file(meta.procFile, procBlob);
    } else if (procBlob) {
      meta.procFile = meta.origFile;
    }

    pageMeta.push(meta);
    opts.onProgress?.(++done, pages.length);
    await new Promise(r => setTimeout(r, 0));
  }

  zip.file('book.json', JSON.stringify({
    format: FORMAT,
    app: 'BOOK_TRANSLATE',
    exportedAt: Date.now(),
    project,
    pages: pageMeta,
    blocks, figures, glossary,
  }, null, 1));

  return zip.generateAsync(
    { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 3 } },
    (m) => opts.onProgress?.(pages.length, pages.length, m.percent));
}

/**
 * 從 zip 還原。一律建立成新的一本書，不覆蓋既有資料 ——
 * 還原時把現有的東西蓋掉是最容易讓人欲哭無淚的設計。
 * @returns {Promise<{project: object, pages: number}>}
 */
export async function importProject(file) {
  const zip = await JSZip.loadAsync(file);

  const metaFile = zip.file('book.json');
  if (!metaFile) throw new Error('這不是本 App 的備份檔（缺少 book.json）');

  const data = JSON.parse(await metaFile.async('string'));
  if (data.app !== 'BOOK_TRANSLATE') throw new Error('這不是本 App 的備份檔');
  if (data.format > FORMAT) {
    throw new Error(`備份檔的格式版本（${data.format}）比目前的 App 新，請先更新 App`);
  }

  // 全部重新發 id：同一份備份可以重複匯入而不會互相覆蓋
  const projectId = db.uid('p_');
  const pageIdMap = new Map();

  const project = {
    ...data.project,
    id: projectId,
    name: data.project.name,
    createdAt: data.project.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  await db.put('projects', project);

  const pages = [];
  for (const meta of data.pages || []) {
    const { origFile, procFile, ...rest } = meta;
    const id = db.uid('pg_');
    pageIdMap.set(meta.id, id);

    const orig = origFile ? await zip.file('images/' + origFile)?.async('blob') : null;
    const proc = procFile
      ? (procFile === origFile ? orig : await zip.file('images/' + procFile)?.async('blob'))
      : null;

    pages.push({
      ...rest,
      id,
      projectId,
      origBlob: orig ? new Blob([orig], { type: 'image/jpeg' }) : null,
      procBlob: proc ? new Blob([proc], { type: 'image/jpeg' }) : null,
    });
    await new Promise(r => setTimeout(r, 0));
  }
  if (pages.length) await db.putMany('pages', pages);

  const remap = (rows, store) => {
    const out = (rows || []).map(r => ({
      ...r,
      id: db.uid(store.slice(0, 2) + '_'),
      projectId,
      pageId: r.pageId ? pageIdMap.get(r.pageId) : undefined,
    })).filter(r => !r.pageId || pageIdMap.has(r.pageId) || r.pageId);
    return out;
  };

  const blocks = remap(data.blocks, 'blocks').filter(b => b.pageId);
  const figures = remap(data.figures, 'figures').filter(f => f.pageId);
  const glossary = (data.glossary || []).map(g => ({
    ...g, id: db.uid('gl_'), projectId,
  }));

  if (blocks.length) await db.putMany('blocks', blocks);
  if (figures.length) await db.putMany('figures', figures);
  if (glossary.length) await db.putMany('glossary', glossary);

  return { project, pages: pages.length };
}

/** 備份檔名：書名加日期，一眼看得出是哪本、哪天備的。 */
export function backupName(projectName) {
  const safe = String(projectName || '未命名書籍').replace(/[\\/:*?"<>|]/g, '_');
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `${safe}-${stamp}.booktr.zip`;
}
