/* 用 canvas 把排版結果畫出來，給預覽用。
   和 PDF 輸出共用同一份 layout 結果，兩邊才不會長得不一樣。 */

import { fitText, EM_ASCENT } from './layout.js';
import { RULE_THICKNESS } from './rules.js';
import { sampleBackground, inkFor, figureOf } from '../pdf/figures.js';

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {import('./layout.js').Glyph[]} glyphs
 * @param {{fontFamily?: string, color?: string}} opts
 */
export function drawGlyphs(ctx, glyphs, opts = {}) {
  const family = opts.fontFamily || '"Noto Serif TC", "Songti TC", serif';
  ctx.save();
  ctx.fillStyle = opts.color || '#111';
  // 刻意不用 'top'：那是字型 hhea 的 ascender，和 PDF 那邊的基準對不上。
  // 兩邊統一用 EM_ASCENT 自己換算，預覽與匯出才會逐像素一致。
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  for (const g of glyphs) {
    ctx.font = `${g.size}px ${family}`;
    const baseline = g.y + g.size * EM_ASCENT;

    if (g.rule) {
      // 實心長條填滿整個字格的高度，相鄰的接起來完全沒有接痕
      const t = g.size * RULE_THICKNESS;
      ctx.fillRect(g.x + (g.size - t) / 2, g.y, t, g.size);
      continue;
    }

    if (g.rotate) {
      // 繞字格中心轉 90°：橫式括號與破折號在直排時要立起來
      ctx.save();
      ctx.translate(g.x + g.size / 2, g.y + g.size / 2);
      ctx.rotate(Math.PI / 2);
      ctx.fillText(g.text, -g.size / 2, g.size * (EM_ASCENT - 0.5));
      ctx.restore();
      continue;
    }

    if (g.tate) {
      // 縦中横：兩位數橫著擠進一個字格
      ctx.save();
      const w = ctx.measureText(g.text).width;
      const k = w > 0 ? Math.min(1, g.size / w) : 1;
      ctx.translate(g.x + (g.size - w * k) / 2, baseline);
      ctx.scale(k, 1);
      ctx.fillText(g.text, 0, 0);
      ctx.restore();
      continue;
    }

    ctx.fillText(g.text, g.x, baseline);
  }
  ctx.restore();
}

/**
 * 把一頁的所有文字塊排版並畫到 canvas 上。
 * @param {{width:number,height:number}} size
 * @param {object[]} blocks 已翻譯的文字塊
 * @param {{scale?:number, showBoxes?:boolean, fontFamily?:string}} opts
 */
export function renderPage(size, blocks, opts = {}) {
  const scale = opts.scale ?? 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(size.width * scale);
  canvas.height = Math.round(size.height * scale);

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);

  // 插圖原樣貼回。有傳影像才畫得出來，預覽才會和匯出一致
  if (opts.image) {
    for (const f of opts.figures || []) {
      ctx.drawImage(opts.image, f.x, f.y, f.w, f.h, f.x, f.y, f.w, f.h);
    }
  }

  const report = [];

  for (const b of blocks) {
    if (b.skipTranslate || !b.dstText) continue;

    const [x, y, w, h] = b.bbox;
    const box = { x, y, w, h };

    /* 圖內文字：蓋掉原字再寫上中譯，和 PDF 匯出的處理一致。
       同樣依當下的圖片框重新判定，不是只看資料庫裡的 kind。
       取樣必須在插圖已經畫上去之後才做，不然取到的是白底。 */
    let ink = null;
    if (opts.image && figureOf(b, opts.figures)) {
      const bg = sampleBackground(opts.image, box);
      const pad = Math.max(3, b.fontSize * 0.2);
      ctx.fillStyle = `rgb(${bg.r},${bg.g},${bg.b})`;
      ctx.fillRect(x - pad, y - pad, w + pad * 2, h + pad * 2);
      const c = inkFor(bg);
      ink = `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;
    }

    const laid = fitText(b.dstText, box, {
      vertical: b.vertical,
      size: b.fontSize,
      indent: b.indent,
    });

    if (opts.showBoxes) {
      ctx.save();
      ctx.strokeStyle = laid.overflow ? 'rgba(217,80,80,.8)' : 'rgba(120,160,220,.45)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, w, h);
      ctx.restore();
    }

    drawGlyphs(ctx, laid.glyphs, { fontFamily: opts.fontFamily, color: ink });
    report.push({
      id: b.id, kind: b.kind,
      scale: laid.scale, overflow: laid.overflow, lines: laid.lines,
    });
  }

  return { canvas, report };
}
