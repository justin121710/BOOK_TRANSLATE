/* 頁面的建立與衍生影像。所有輸入來源最後都收斂成同一種 page 紀錄。 */

import * as db from '../state/db.js';
import { fitTo, toBlob, blobToBitmap, removeShadow } from '../preprocess/enhance.js';
import { warp, fullFrame, isFullFrame, orderCorners } from '../preprocess/warp.js';

/** 存進 IndexedDB 的原圖上限。留得比 OCR 用的大，之後裁圖貼回 PDF 才有餘裕。 */
const STORE_MAX_EDGE = 3000;

/**
 * page 紀錄的形狀：
 * {
 *   id, projectId, index,
 *   status: 'pending' | 'ocr' | 'translated' | 'done' | 'failed',
 *   source: 'camera' | 'photo' | 'pdf' | 'epub',
 *   origBlob, origW, origH,        原圖（已縮到上限），永遠保留
 *   corners: [[x,y]×4] | null,     原圖像素座標；null 表示還沒校正
 *   procBlob, procW, procH,        校正後的彩色影像，OCR 與貼圖都用它
 *   nativeText: [...] | null,      PDF 原生文字層，有的話就不必 OCR
 *   error: string | null,
 * }
 */

export async function nextIndex(projectId) {
  const pages = await db.getBy('pages', 'projectId', projectId);
  return pages.reduce((m, p) => Math.max(m, p.index + 1), 0);
}

/**
 * 從一張影像建立頁面。
 * @param {string} projectId
 * @param {Blob} blob 原始影像
 * @param {{source?: string, index?: number, nativeText?: any[]}} meta
 */
export async function addImagePage(projectId, blob, meta = {}) {
  const bitmap = await blobToBitmap(blob);

  // 手機相機動輒 12MP，原樣存進 IndexedDB 幾十頁就爆了
  const needsResize = Math.max(bitmap.width, bitmap.height) > STORE_MAX_EDGE;
  const canvas = needsResize ? fitTo(bitmap, STORE_MAX_EDGE) : null;
  const stored = canvas ? await toBlob(canvas, 'image/jpeg', 0.92) : blob;
  const w = canvas ? canvas.width : bitmap.width;
  const h = canvas ? canvas.height : bitmap.height;

  bitmap.close?.();

  const page = {
    id: db.uid('pg_'),
    projectId,
    index: meta.index ?? await nextIndex(projectId),
    status: 'pending',
    source: meta.source || 'photo',
    origBlob: stored,
    origW: w,
    origH: h,
    // PDF 匯入的頁面本來就是平的，不需要校正
    corners: meta.source === 'pdf' ? fullFrame(w, h) : null,
    procBlob: meta.source === 'pdf' ? stored : null,
    procW: meta.source === 'pdf' ? w : 0,
    procH: meta.source === 'pdf' ? h : 0,
    nativeText: meta.nativeText || null,
    error: null,
    createdAt: Date.now(),
  };

  await db.put('pages', page);
  return page;
}

/**
 * 套用四角校正，產生 procBlob。
 * @param {object} page
 * @param {[number,number][]|null} corners 原圖像素座標；傳 null 代表整頁不裁切
 */
export async function applyCorners(page, corners) {
  const pts = corners ? orderCorners(corners) : fullFrame(page.origW, page.origH);
  const bitmap = await blobToBitmap(page.origBlob);

  let canvas;
  if (isFullFrame(pts, page.origW, page.origH)) {
    // 沒真的動到角就不要重繪，省一次全尺寸繪圖也避免無謂的重新編碼
    canvas = null;
  } else {
    canvas = warp(bitmap, pts);
  }

  const next = { ...page, corners: pts };
  if (canvas) {
    next.procBlob = await toBlob(canvas, 'image/jpeg', 0.92);
    next.procW = canvas.width;
    next.procH = canvas.height;
  } else {
    next.procBlob = page.origBlob;
    next.procW = page.origW;
    next.procH = page.origH;
  }

  bitmap.close?.();
  await db.put('pages', next);
  return next;
}

/** 校正後的影像；還沒校正過就即時用原圖頂著。EPUB 那條路沒有影像，回傳 null。 */
export async function processedBlob(page) {
  return page.procBlob || page.origBlob || null;
}

/** OCR 用的影像：在校正後的基礎上去陰影。不落地儲存，每次即時算。 */
export async function ocrBlob(page, { shadow = 1 } = {}) {
  const src = await processedBlob(page);
  const bitmap = await blobToBitmap(src);
  const sized = fitTo(bitmap);
  const clean = shadow > 0 ? removeShadow(sized, { strength: shadow }) : sized;
  bitmap.close?.();
  return {
    blob: await toBlob(clean, 'image/jpeg', 0.88),
    width: clean.width,
    height: clean.height,
  };
}

export async function listPages(projectId) {
  const pages = await db.getBy('pages', 'projectId', projectId);
  return pages.sort((a, b) => a.index - b.index);
}

export async function deletePage(pageId) {
  await db.delBy('blocks', 'pageId', pageId);
  await db.delBy('figures', 'pageId', pageId);
  await db.del('pages', pageId);
}

/** 刪除後補平 index，讓頁碼不會出現空洞。 */
export async function renumber(projectId) {
  const pages = await listPages(projectId);
  const changed = [];
  pages.forEach((p, i) => {
    if (p.index !== i) { p.index = i; changed.push(p); }
  });
  if (changed.length) await db.putMany('pages', changed);
  return pages;
}
