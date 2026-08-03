/* 把一段譯文排進一個矩形框，產出「每個字要畫在哪、要不要轉」的指令清單。
 *
 * 這一層不碰 PDF 也不碰 canvas，只算座標。所以同一份結果可以用 canvas 畫預覽、
 * 也可以用 pdf-lib 畫成品，兩邊保證長得一樣 —— 預覽跟匯出對不上是最難查的那種 bug。
 *
 * 座標系與 OCR 一致：原點左上、y 向下。輸出給 pdf-lib 時再翻轉。
 */

import { placement, segment, breakLines, HALF_WIDTH_IN_VERTICAL, RULE_CHARS } from './rules.js';

/**
 * 字面框頂端到基線的距離，以字身為單位。
 *
 * Glyph 的 y 一律代表「字面框的頂端」。canvas 與 PDF 兩邊都必須用這個常數
 * 換算到各自的基線，否則預覽和匯出會差幾個像素 —— 那種偏差很難查，
 * 因為兩邊單獨看都是對的。
 *
 * 不能用 canvas 的 textBaseline='top'：它取的是字型 hhea 的 ascender，
 * Noto CJK 約 1.16 em，和 PDF 的排版基準不一致。
 */
export const EM_ASCENT = 0.88;

/**
 * @typedef {object} Glyph
 * @property {string} text   要畫的字（縦中横時是兩個字元）
 * @property {number} x      左上角
 * @property {number} y
 * @property {number} size   字身大小
 * @property {boolean} rotate 是否旋轉 90°
 * @property {boolean} tate  是否為縦中横組
 */

/**
 * 直排：從框的右上角開始往下排，一欄滿了往左移一欄。
 * @param {string} text
 * @param {{x:number,y:number,w:number,h:number}} box
 * @param {{size:number, lineGap?:number, letterGap?:number}} opts
 * @returns {{glyphs: Glyph[], lines: number, overflow: boolean, usedW: number}}
 */
export function layoutVertical(text, box, opts) {
  const size = opts.size;
  const lineGap = opts.lineGap ?? size * 0.28;    // 欄距
  const letterGap = opts.letterGap ?? 0;
  const advance = size + letterGap;
  const colWidth = size + lineGap;

  const glyphs = [];
  let maxCols = 0;

  const paragraphs = String(text).split('\n');
  // 一欄能放幾個字。留 2% 餘裕，免得最後一個字被邊界切到
  const perLine = Math.max(1, Math.floor((box.h * 0.98 + letterGap) / advance));
  // 中文的段首縮排是兩個全形字，和日文的一字下げ不同
  const indent = opts.indent ? 2 : 0;

  let col = 0;   // 目前在第幾欄，從右邊數過來

  for (const para of paragraphs) {
    if (!para) { col++; continue; }               // 空行也要佔一欄，段落間距才對

    const units = segment(para);
    // 縮排會吃掉第一欄的可用字數，斷欄要據此計算，否則第一欄會排到框外
    const starts = indent
      ? breakLinesWithIndent(units, perLine, indent)
      : breakLines(units, perLine);

    for (let s = 0; s < starts.length; s++) {
      const from = starts[s];
      const to = s + 1 < starts.length ? starts[s + 1] : units.length;

      // 欄從右往左推進
      const cx = box.x + box.w - (col + 1) * colWidth + lineGap / 2;
      // 只有段落的第一欄要縮
      let cy = box.y + (s === 0 ? indent * advance : 0);

      for (let i = from; i < to; i++) {
        const u = units[i];

        // 破折號與連接線畫成實心長條，逐字旋轉會在相鄰兩個之間留下細縫
        if (!u.tate && RULE_CHARS.has(u.text)) {
          glyphs.push({ text: u.text, x: cx, y: cy, size, rule: true });
          cy += advance;
          continue;
        }

        const p = u.tate
          ? { rotate: false, offsetX: 0, offsetY: 0 }
          : placement(u.text);

        glyphs.push({
          text: u.text,
          x: cx + p.offsetX * size,
          y: cy + p.offsetY * size,
          size,
          rotate: p.rotate,
          tate: u.tate,
        });
        cy += advance;
      }
      col++;
      maxCols = Math.max(maxCols, col);
    }
  }

  const usedW = maxCols * colWidth;
  return { glyphs, lines: maxCols, overflow: usedW > box.w + 0.5, usedW };
}

/**
 * 橫排：從左上角往右排，滿了換行。
 */
export function layoutHorizontal(text, box, opts) {
  const size = opts.size;
  const lineGap = opts.lineGap ?? size * 0.42;
  const letterGap = opts.letterGap ?? 0;
  const advance = size + letterGap;
  const lineHeight = size + lineGap;

  const glyphs = [];
  let row = 0;

  const paragraphs = String(text).split('\n');
  const perLine = Math.max(1, Math.floor((box.w * 0.98 + letterGap) / advance));
  const indent = opts.indent ? 2 : 0;

  for (const para of paragraphs) {
    if (!para) { row++; continue; }

    const units = [...para].map(c => ({ text: c, tate: false }));
    const starts = indent
      ? breakLinesWithIndent(units, perLine, indent)
      : breakLines(units, perLine);

    for (let s = 0; s < starts.length; s++) {
      const from = starts[s];
      const to = s + 1 < starts.length ? starts[s + 1] : units.length;

      let cx = box.x + (s === 0 ? indent * advance : 0);
      const cy = box.y + row * lineHeight;

      for (let i = from; i < to; i++) {
        glyphs.push({
          text: units[i].text, x: cx, y: cy, size, rotate: false, tate: false,
        });
        cx += advance;
      }
      row++;
    }
  }

  const usedH = row * lineHeight;
  return { glyphs, lines: row, overflow: usedH > box.h + 0.5, usedH };
}

/**
 * 有段首縮排時的斷行。
 * 第一行少了 indent 個位置，其餘行照舊；直接套 breakLines 會讓第一行排到框外。
 */
function breakLinesWithIndent(units, perLine, indent) {
  const first = Math.max(1, perLine - indent);
  if (units.length <= first) return [0];

  // 先切出第一行，剩下的照一般規則切，再把索引平移回來
  const rest = breakLines(units.slice(first), perLine);
  return [0, ...rest.map(i => i + first)];
}

/**
 * 依規格要求：框線固定，字級自動縮放到塞得下為止。
 *
 * 中文字數約為日文的 0.6–0.8 倍，多數情況會有剩餘空間；
 * 但標題、圖說這種原本就排得很滿的框仍可能爆掉，所以要往下找。
 *
 * @param {string} text
 * @param {{x,y,w,h}} box
 * @param {{vertical:boolean, size:number, minScale?:number}} opts
 * @returns {{glyphs:Glyph[], size:number, scale:number, overflow:boolean, lines:number}}
 */
export function fitText(text, box, opts) {
  const vertical = opts.vertical;
  const run = vertical ? layoutVertical : layoutHorizontal;
  const minScale = opts.minScale ?? 0.08;
  const indent = Boolean(opts.indent);

  const full = run(text, box, { size: opts.size, indent });
  if (!full.overflow) {
    return { ...full, size: opts.size, scale: 1 };
  }

  // 二分搜尋最大的可容納字級。overflow 對字級是單調的，所以二分是安全的。
  let lo = minScale, hi = 1, best = null;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    const r = run(text, box, { size: opts.size * mid, indent });
    if (r.overflow) {
      hi = mid;
    } else {
      lo = mid;
      best = { ...r, size: opts.size * mid, scale: mid };
    }
    if (hi - lo < 0.004) break;
  }

  if (best) return best;

  // 縮到下限還是塞不下：照下限排出來，並如實標記溢出，
  // 讓預覽頁能把這一塊標出來給使用者處理，而不是默默截斷。
  const floor = run(text, box, { size: opts.size * minScale, indent });
  return { ...floor, size: opts.size * minScale, scale: minScale, overflow: true };
}

/**
 * 直排時全形標點的墨水只佔半格，量寬度時要扣掉，
 * 否則整欄會被撐開看起來鬆散。目前只用於估算，實際繪製仍逐字定位。
 */
export function inkWidth(ch, size) {
  return HALF_WIDTH_IN_VERTICAL.has(ch) ? size * 0.5 : size;
}
