/* 一頁的文字辨識流程。
   有原生文字層就走 native，沒有才送 Vision —— 後者要錢，前者不要。 */

import * as db from '../state/db.js';
import * as vision from '../api/vision.js';
import { settings } from '../state/settings.js';
import { ocrBlob, processedBlob } from '../input/pages.js';
import { blobToBase64, blobToBitmap } from '../preprocess/enhance.js';
import { parseVision } from './parse.js';
import { parseNative } from './native.js';

/**
 * 辨識一頁並把文字塊寫進資料庫。
 * @param {object} page
 * @param {{force?: boolean, signal?: AbortSignal}} opts
 */
export async function recognisePage(page, opts = {}) {
  const existing = await db.getBy('blocks', 'pageId', page.id);
  if (existing.length && !opts.force) {
    return { blocks: existing, source: 'cached', cost: 0 };
  }

  let parsed, source, cost = 0;

  if (page.nativeText?.length) {
    parsed = parseNative(page.nativeText);
    source = 'native';
  } else {
    const img = await ocrBlob(page, { shadow: 1 });
    const content = await blobToBase64(img.blob);

    const [res] = await vision.annotate([{
      image: { content },
      features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
      imageContext: { languageHints: ['ja'] },
    }]);

    parsed = parseVision(res, { dropRuby: settings.dropRuby });
    source = 'vision';
    cost = 1;

    // Vision 拿到的是縮放過的影像，座標得換算回 procBlob 的尺度，
    // 否則後面貼圖與重排的位置會整個對不上
    const scale = (page.procW || page.origW) / img.width;
    if (Math.abs(scale - 1) > 0.001) rescale(parsed.blocks, scale);
  }

  await db.delBy('blocks', 'pageId', page.id);

  const rows = parsed.blocks.map(b => ({
    ...b,
    id: db.uid('bk_'),
    pageId: page.id,
    projectId: page.projectId,
  }));
  if (rows.length) await db.putMany('blocks', rows);

  await db.put('pages', {
    ...page,
    status: rows.length ? 'ocr' : 'failed',
    vertical: parsed.vertical,
    rubyDropped: parsed.rubyDropped?.length || 0,
    error: rows.length ? null : '這一頁沒有辨識到任何文字',
  });

  return { blocks: rows, source, cost, vertical: parsed.vertical, rubyDropped: parsed.rubyDropped };
}

function rescale(blocks, k) {
  for (const b of blocks) {
    b.bbox = b.bbox.map(v => v * k);
    b.fontSize *= k;
    if (b.poly) b.poly = b.poly.map(([x, y]) => [x * k, y * k]);
    for (const l of b.lines) l.bbox = l.bbox.map(v => v * k);
  }
}

/**
 * 依序辨識多頁。每頁獨立成敗，一頁壞掉不影響其他頁。
 * @param {object[]} pages
 * @param {{onProgress?: Function, force?: boolean, signal?: AbortSignal}} opts
 */
export async function recognisePages(pages, opts = {}) {
  const out = { done: 0, failed: 0, cost: 0, errors: [] };

  for (const page of pages) {
    if (opts.signal?.aborted) break;
    try {
      const r = await recognisePage(page, opts);
      out.cost += r.cost;
      out.done++;
    } catch (e) {
      out.failed++;
      out.errors.push({ page: page.index + 1, message: e.message });
      await db.put('pages', { ...page, status: 'failed', error: e.message });
    }
    opts.onProgress?.(out.done + out.failed, pages.length, out);
    await new Promise(r => setTimeout(r, 0));
  }
  return out;
}

/** 把文字塊畫在頁面影像上，給預覽與除錯用。 */
export async function renderOverlay(page, blocks, { scale = 1 } = {}) {
  const bmp = await blobToBitmap(await processedBlob(page));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);

  blocks.forEach((b, i) => {
    ctx.strokeStyle = b.vertical ? 'rgba(80,160,255,.9)' : 'rgba(255,60,120,.9)';
    ctx.lineWidth = 2 / scale;
    ctx.strokeRect(...b.bbox);

    // 標上閱讀順序，右→左的欄序對不對一眼就看得出來
    const [x, y, w] = b.bbox;
    ctx.fillStyle = b.vertical ? 'rgba(80,160,255,.9)' : 'rgba(255,60,120,.9)';
    ctx.fillRect(x + w - 22 / scale, y, 22 / scale, 18 / scale);
    ctx.fillStyle = '#fff';
    ctx.font = `${13 / scale}px system-ui`;
    ctx.textAlign = 'center';
    ctx.fillText(String(i + 1), x + w - 11 / scale, y + 13 / scale);
  });

  bmp.close?.();
  return canvas;
}
