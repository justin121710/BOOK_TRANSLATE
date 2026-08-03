/* PDF 匯入。
 *
 * 兩條路：
 *  1. 原生文字 PDF —— getTextContent() 直接給出 glyph 級的精確座標，
 *     完全不必送 OCR。品質最高、成本為零，能走這條就走這條。
 *  2. 掃描成影像的 PDF —— 只能 render 成點陣圖再走 Vision。
 *
 * 判斷方式是看整份文件抽得出多少字，掃描件通常是零，
 * 但也有些掃描件夾帶爛掉的 OCR 文字層，所以用「每頁平均字數」而不是「有沒有字」。
 */

import * as pdfjs from 'pdfjs-dist/build/pdf.min.mjs';
import { addImagePage, nextIndex } from './pages.js';
import { toBlob } from '../preprocess/enhance.js';

pdfjs.GlobalWorkerOptions.workerSrc =
  'https://esm.sh/pdfjs-dist@4.6.82/build/pdf.worker.min.mjs';

const RENDER_MAX_EDGE = 2400;
const NATIVE_TEXT_MIN_CHARS_PER_PAGE = 40;   // 低於這個就當作沒有可用的文字層

export async function openPdf(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  try {
    return await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  } catch (e) {
    if (e?.name === 'PasswordException') throw new Error('這份 PDF 有密碼保護，無法讀取');
    throw new Error('無法開啟 PDF：' + (e?.message || e));
  }
}

/** 抽樣前幾頁判斷這份 PDF 有沒有可用的原生文字層。 */
export async function probeNativeText(doc, sample = 5) {
  const n = Math.min(sample, doc.numPages);
  let chars = 0;
  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    chars += tc.items.reduce((s, it) => s + (it.str?.length || 0), 0);
    page.cleanup();
  }
  return {
    hasNativeText: chars / n >= NATIVE_TEXT_MIN_CHARS_PER_PAGE,
    avgChars: Math.round(chars / n),
  };
}

/**
 * 匯入整份 PDF。
 * @param {string} projectId
 * @param {File} file
 * @param {{onProgress?: (done:number, total:number)=>void, useNativeText?: boolean,
 *          from?: number, to?: number}} opts
 */
export async function importPdf(projectId, file, opts = {}) {
  const doc = await openPdf(file);
  const probe = await probeNativeText(doc);
  const useNative = opts.useNativeText ?? probe.hasNativeText;

  const from = Math.max(1, opts.from || 1);
  const to = Math.min(doc.numPages, opts.to || doc.numPages);
  const total = to - from + 1;

  let index = await nextIndex(projectId);
  const created = [];

  for (let n = from; n <= to; n++) {
    const page = await doc.getPage(n);

    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(RENDER_MAX_EDGE / Math.max(base.width, base.height), 3);
    const vp = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;

    let nativeText = null;
    if (useNative) {
      const tc = await page.getTextContent();
      nativeText = extractItems(tc, vp);
      if (!nativeText.length) nativeText = null;
    }

    const blob = await toBlob(canvas, 'image/jpeg', 0.92);
    created.push(await addImagePage(projectId, blob, {
      source: 'pdf',
      index: index++,
      nativeText,
    }));

    page.cleanup();
    opts.onProgress?.(n - from + 1, total);

    // 讓出主執行緒，不然手機上整個介面會凍住
    await new Promise(r => setTimeout(r, 0));
  }

  doc.destroy();
  return { pages: created, usedNativeText: useNative, probe };
}

/**
 * 把 pdf.js 的文字項目轉成畫布像素座標的方框。
 * 這裡輸出的形狀要和 OCR 那條路一致，後面的版面分析才能共用同一套程式。
 */
function extractItems(textContent, viewport) {
  const out = [];
  for (const it of textContent.items) {
    if (!it.str || !it.str.trim()) continue;

    // item.transform 是 PDF 空間的矩陣，乘上 viewport.transform 才是畫布座標
    const m = pdfjs.Util.transform(viewport.transform, it.transform);

    // 字高取矩陣的垂直縮放量；直排時 b/c 才是主要分量
    const fontHeight = Math.hypot(m[2], m[3]) || Math.hypot(m[0], m[1]);
    const vertical = it.dir === 'ttb';

    const w = (it.width || 0) * viewport.scale;
    const h = (it.height || fontHeight) * viewport.scale || fontHeight;

    // m[4], m[5] 是基線起點。橫排時方框往上長，直排時往右長。
    const x = m[4];
    const y = m[5];

    out.push({
      str: it.str,
      vertical,
      // 統一成左上角原點的方框
      bbox: vertical
        ? [x - fontHeight * 0.5, y, fontHeight, Math.max(h, w)]
        : [x, y - fontHeight * 0.82, Math.max(w, fontHeight * 0.5), fontHeight],
      fontName: it.fontName,
      hasEOL: Boolean(it.hasEOL),
    });
  }
  return out;
}
