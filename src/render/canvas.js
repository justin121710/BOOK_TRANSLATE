/* 用 canvas 把排版結果畫出來，給預覽用。
   和 PDF 輸出共用同一份 layout 結果，兩邊才不會長得不一樣。 */

import { fitText } from './layout.js';

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {import('./layout.js').Glyph[]} glyphs
 * @param {{fontFamily?: string, color?: string}} opts
 */
export function drawGlyphs(ctx, glyphs, opts = {}) {
  const family = opts.fontFamily || '"Noto Serif TC", "Songti TC", serif';
  ctx.save();
  ctx.fillStyle = opts.color || '#111';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';

  for (const g of glyphs) {
    ctx.font = `${g.size}px ${family}`;

    if (g.rotate) {
      // 繞字格中心轉 90°：橫式括號與破折號在直排時要立起來
      ctx.save();
      ctx.translate(g.x + g.size / 2, g.y + g.size / 2);
      ctx.rotate(Math.PI / 2);
      ctx.fillText(g.text, -g.size / 2, -g.size / 2);
      ctx.restore();
      continue;
    }

    if (g.tate) {
      // 縦中横：兩位數橫著擠進一個字格
      ctx.save();
      const w = ctx.measureText(g.text).width;
      const k = w > 0 ? Math.min(1, g.size / w) : 1;
      ctx.translate(g.x + (g.size - w * k) / 2, g.y);
      ctx.scale(k, 1);
      ctx.fillText(g.text, 0, 0);
      ctx.restore();
      continue;
    }

    ctx.fillText(g.text, g.x, g.y);
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

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);

  const report = [];

  for (const b of blocks) {
    if (b.skipTranslate || !b.dstText) continue;

    const [x, y, w, h] = b.bbox;
    const box = { x, y, w, h };
    const laid = fitText(b.dstText, box, {
      vertical: b.vertical,
      size: b.fontSize,
    });

    if (opts.showBoxes) {
      ctx.save();
      ctx.strokeStyle = laid.overflow ? 'rgba(217,80,80,.8)' : 'rgba(120,160,220,.45)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, w, h);
      ctx.restore();
    }

    drawGlyphs(ctx, laid.glyphs, { fontFamily: opts.fontFamily });
    report.push({ id: b.id, scale: laid.scale, overflow: laid.overflow, lines: laid.lines });
  }

  return { canvas, report };
}
