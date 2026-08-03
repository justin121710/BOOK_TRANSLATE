/* 產生成品 PDF。
 *
 * 字型路線見 fonts.js 開頭的說明 —— 一定要走 harfbuzz 子集化後再用
 * subset:false 嵌入，不要讓 pdf-lib 自己處理 CJK 子集。
 *
 * 排版結果來自 render/layout.js，和預覽畫面用的是同一份，
 * 所以匯出不會跟預覽長得不一樣。
 */

import { PDFDocument, rgb, degrees } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

import * as db from '../state/db.js';
import { settings } from '../state/settings.js';
import { loadFont, subsetFont, findMissingGlyphs } from './fonts.js';
import { crop } from './figures.js';
import { processedBlob } from '../input/pages.js';
import { blobToBitmap, toBlob } from '../preprocess/enhance.js';
import { fitText, EM_ASCENT } from '../render/layout.js';
import { RULE_THICKNESS } from '../render/rules.js';

/** 頁面長邊對應的 PDF 點數。842pt 是 A4 的長邊，印出來大小剛好。 */
const TARGET_LONG_EDGE = 842;

/** 標題用黑體，其餘用宋體。 */
const TITLE_KINDS = new Set(['title']);

/**
 * @param {object} project
 * @param {object[]} pages 已翻譯的頁面，依 index 排序
 * @param {{withOriginal?: boolean, onProgress?: Function, signal?: AbortSignal}} opts
 * @returns {Promise<{blob: Blob, warnings: object[]}>}
 */
export async function exportPdf(project, pages, opts = {}) {
  if (!pages.length) throw new Error('沒有可以匯出的頁面');

  const total = pages.length;
  const warnings = [];
  const report = (n, note) => opts.onProgress?.(n, total, note);

  report(0, '載入字型…');
  const [serifRaw, sansRaw] = await Promise.all([loadFont('serif'), loadFont('sans')]);

  // 先把整份文件會用到的字收齊，兩套字型各只子集化並嵌入一次。
  // 逐頁子集化會讓檔案裡出現幾十份字型，體積直接失控。
  const bodyChars = new Set();
  const titleChars = new Set();
  const blocksByPage = new Map();

  for (const page of pages) {
    const blocks = (await db.getBy('blocks', 'pageId', page.id))
      .sort((a, b) => a.order - b.order);
    blocksByPage.set(page.id, blocks);
    for (const b of blocks) {
      if (b.skipTranslate || !b.dstText) continue;
      const target = TITLE_KINDS.has(b.kind) ? titleChars : bodyChars;
      for (const ch of b.dstText) target.add(ch);
    }
  }

  if (!bodyChars.size && !titleChars.size) {
    throw new Error('這些頁面還沒有任何譯文，請先執行翻譯');
  }

  // 缺字檢查：Noto TC 沒有日文專用漢字，殘留的日文人名會變成空白
  for (const [chars, id] of [[bodyChars, 'serif'], [titleChars, 'sans']]) {
    if (!chars.size) continue;
    const missing = await findMissingGlyphs(id, [...chars].join(''));
    if (missing.length) {
      warnings.push({
        type: 'missing-glyph',
        font: id,
        chars: missing,
        message: `有 ${missing.length} 個字在字型裡沒有字形，會顯示為空白：${missing.join('')}`,
      });
    }
  }

  report(0, '子集化字型…');
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(project.name || '未命名書籍');
  pdf.setCreator('BOOK_TRANSLATE');

  const serif = bodyChars.size
    ? await pdf.embedFont(await subsetFont(serifRaw, [[...bodyChars].join('')]), { subset: false })
    : null;
  const sans = titleChars.size
    ? await pdf.embedFont(await subsetFont(sansRaw, [[...titleChars].join('')]), { subset: false })
    : null;

  for (const [i, page] of pages.entries()) {
    if (opts.signal?.aborted) throw new Error('已取消');
    report(i, `第 ${page.index + 1} 頁`);

    const blocks = blocksByPage.get(page.id) || [];
    const srcW = page.procW || page.origW;
    const srcH = page.procH || page.origH;
    const k = TARGET_LONG_EDGE / Math.max(srcW, srcH);   // 影像像素 → PDF 點
    const pw = srcW * k, ph = srcH * k;

    const bitmap = await blobToBitmap(await processedBlob(page));

    // 對照模式：原頁掃描放在譯文頁前面
    if (opts.withOriginal) {
      const orig = pdf.addPage([pw, ph]);
      const jpg = await pdf.embedJpg(await (await toBlob(toCanvas(bitmap), 'image/jpeg', 0.82)).arrayBuffer());
      orig.drawImage(jpg, { x: 0, y: 0, width: pw, height: ph });
    }

    const out = pdf.addPage([pw, ph]);

    // 插圖：原樣裁切貼回原座標
    const figures = await db.getBy('figures', 'pageId', page.id);
    for (const f of figures) {
      const c = crop(bitmap, f);
      const jpg = await pdf.embedJpg(await (await toBlob(c, 'image/jpeg', 0.85)).arrayBuffer());
      out.drawImage(jpg, {
        x: f.x * k,
        y: ph - (f.y + f.h) * k,     // PDF 原點在左下，y 要翻轉
        width: f.w * k,
        height: f.h * k,
      });
    }

    for (const b of blocks) {
      // 頁眉、頁碼、側標不翻譯：從原圖裁下來貼回，保留原樣也避開缺字問題
      if (b.skipTranslate) {
        const [bx, by, bw, bh] = b.bbox;
        const c = crop(bitmap, { x: bx, y: by, w: bw, h: bh });
        const jpg = await pdf.embedJpg(await (await toBlob(c, 'image/jpeg', 0.9)).arrayBuffer());
        out.drawImage(jpg, {
          x: bx * k, y: ph - (by + bh) * k, width: bw * k, height: bh * k,
        });
        continue;
      }
      if (!b.dstText) continue;

      const font = TITLE_KINDS.has(b.kind) ? (sans || serif) : (serif || sans);
      if (!font) continue;

      const [bx, by, bw, bh] = b.bbox;
      const laid = fitText(b.dstText, { x: bx, y: by, w: bw, h: bh }, {
        vertical: b.vertical,
        size: b.fontSize,
        minScale: settings.minFontScale,
      });

      if (laid.overflow) {
        warnings.push({
          type: 'overflow',
          page: page.index + 1,
          blockId: b.id,
          message: `第 ${page.index + 1} 頁有一塊文字縮到下限仍然放不下`,
        });
      }

      for (const g of laid.glyphs) {
        drawGlyph(out, font, g, k, ph);
      }
    }

    bitmap.close?.();
    // 讓出主執行緒，手機上整份書才不會把介面凍住
    await new Promise(r => setTimeout(r, 0));
  }

  report(total, '寫出檔案…');
  const bytes = await pdf.save();
  return { blob: new Blob([bytes], { type: 'application/pdf' }), warnings };
}

/**
 * 畫一個字。
 * layout 的座標是左上原點、y 向下，且 g.y 指的是字面框頂端；
 * PDF 是左下原點、y 向上，且定位的是基線。這裡是唯一做這個換算的地方。
 */
function drawGlyph(page, font, g, k, pageH) {
  const size = g.size * k;
  const baselineTop = g.y + g.size * EM_ASCENT;   // 影像座標系裡的基線位置

  if (g.rule) {
    // 破折號畫成實心長條，和預覽那邊一致
    const t = size * RULE_THICKNESS;
    page.drawRectangle({
      x: g.x * k + (size - t) / 2,
      y: pageH - (g.y + g.size) * k,
      width: t,
      height: size,
      color: rgb(0.1, 0.1, 0.1),
    });
    // 再疊一層完全透明的文字：畫面上看不到，但複製貼上與搜尋時破折號還在。
    // 少了這步，文字層會直接漏掉這個字。
    try {
      page.drawText(g.text, {
        x: g.x * k,
        y: pageH - baselineTop * k,
        size, font, opacity: 0,
      });
    } catch {
      // 這個字沒被子集化進去就算了，長條已經畫出來，視覺上不受影響
    }
    return;
  }

  if (g.rotate) {
    // 繞字格中心轉 90°。pdf-lib 的 rotate 是繞繪製原點轉，所以原點要自己算好
    const cx = (g.x + g.size / 2) * k;
    const cy = pageH - (g.y + g.size / 2) * k;
    const half = size / 2;
    page.drawText(g.text, {
      x: cx + half,
      y: cy - half + size * (EM_ASCENT - 0.5),
      size, font, rotate: degrees(-90), color: rgb(0.1, 0.1, 0.1),
    });
    return;
  }

  if (g.tate) {
    // 縦中横：兩位數橫著擠進一個字格。太寬就水平壓縮
    const w = font.widthOfTextAtSize(g.text, size);
    const scale = w > 0 ? Math.min(1, size / w) : 1;
    page.drawText(g.text, {
      x: g.x * k + (size - w * scale) / 2,
      y: pageH - baselineTop * k,
      size: size * scale,
      font, color: rgb(0.1, 0.1, 0.1),
    });
    return;
  }

  page.drawText(g.text, {
    x: g.x * k,
    y: pageH - baselineTop * k,
    size, font, color: rgb(0.1, 0.1, 0.1),
  });
}

function toCanvas(image) {
  const c = document.createElement('canvas');
  c.width = image.width;
  c.height = image.height;
  c.getContext('2d').drawImage(image, 0, 0);
  return c;
}

/** 觸發下載。iOS Safari 對 blob 下載的支援有限，所以另開分頁比較保險。 */
export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return url;
}
