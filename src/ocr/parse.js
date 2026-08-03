/* 把 Google Vision 的 fullTextAnnotation 拆成可翻譯、可重排的文字塊。
 *
 * 這支是純函式，不碰網路也不碰資料庫 —— 直排偵測、右→左欄序、振り仮名剔除
 * 全都在這裡，所以可以用固定樣本測到底，不必每次都燒 API 額度。
 *
 * 輸出的 block 形狀刻意和 PDF 原生文字層那條路一致（見 native.js），
 * 後面的翻譯與排版才能共用同一套程式。
 */

/* Vision 的 vertices 會省略值為 0 的欄位：{"y":100} 代表 x=0。
   直接讀 v.x 會拿到 undefined，算出來的框就會整個歪掉。 */
const vx = (v) => v.x || 0;
const vy = (v) => v.y || 0;

function boxOf(boundingBox) {
  const vs = boundingBox?.vertices || boundingBox?.normalizedVertices || [];
  if (!vs.length) return null;
  const xs = vs.map(vx), ys = vs.map(vy);
  const x = Math.min(...xs), y = Math.min(...ys);
  return {
    x, y,
    w: Math.max(...xs) - x,
    h: Math.max(...ys) - y,
    poly: vs.map(v => [vx(v), vy(v)]),
  };
}

const centreOf = (b) => [b.x + b.w / 2, b.y + b.h / 2];

/* ---------- 字元類別 ---------- */

const RE_KANA = /^[぀-ゟ゠-ヿㇰ-ㇿ々ー]+$/;
const RE_HAS_KANJI = /[一-鿿㐀-䶿]/;

const isAllKana = (s) => RE_KANA.test(s);

/* ---------- 主要入口 ---------- */

/**
 * @param {object} response Vision 的單一 response 物件
 * @param {{dropRuby?: boolean}} opts
 * @returns {{blocks: object[], vertical: boolean, width: number, height: number, rubyDropped: string[]}}
 */
export function parseVision(response, opts = {}) {
  const dropRuby = opts.dropRuby !== false;
  const fta = response?.fullTextAnnotation;
  const page = fta?.pages?.[0];
  if (!page) return { blocks: [], vertical: false, width: 0, height: 0, rubyDropped: [] };

  const rubyDropped = [];
  const raw = [];

  for (const vBlock of page.blocks || []) {
    // 圖片、表格之類的非文字區塊在這裡沒有意義
    if (vBlock.blockType && vBlock.blockType !== 'TEXT') continue;

    for (const para of vBlock.paragraphs || []) {
      const block = buildBlock(para, { dropRuby, rubyDropped });
      if (block) raw.push(block);
    }
  }

  // 整頁的走向由文字量決定，不是由塊數 —— 一兩個橫排的頁碼不該翻轉整頁
  const verticalChars = raw.filter(b => b.vertical).reduce((s, b) => s + b.srcText.length, 0);
  const totalChars = raw.reduce((s, b) => s + b.srcText.length, 0);
  const vertical = totalChars > 0 && verticalChars / totalChars > 0.5;

  const blocks = orderBlocks(raw, vertical);
  blocks.forEach((b, i) => { b.order = i; });

  return {
    blocks,
    vertical,
    width: page.width || 0,
    height: page.height || 0,
    rubyDropped,
  };
}

/* ---------- 單一段落 ---------- */

function buildBlock(para, { dropRuby, rubyDropped }) {
  const words = (para.words || []).map(w => {
    const box = boxOf(w.boundingBox);
    if (!box) return null;
    const text = (w.symbols || []).map(s => s.text || '').join('');
    if (!text) return null;
    const lastBreak = w.symbols?.[w.symbols.length - 1]?.property?.detectedBreak?.type;
    return { text, box, lastBreak };
  }).filter(Boolean);

  if (!words.length) return null;

  const vertical = detectVertical(words);

  // 主字大小：直排看寬度、橫排看高度。用中位數，才不會被一兩個大字拉走
  const sizes = words.map(w => vertical ? w.box.w : w.box.h);
  const median = medianOf(sizes);

  let kept = words;
  if (dropRuby) {
    const result = stripRuby(words, median, vertical);
    kept = result.kept;
    rubyDropped.push(...result.dropped);
  }
  if (!kept.length) return null;

  const lines = groupLines(kept, vertical, median);
  const srcText = lines.map(l => l.text).join('\n');
  if (!srcText.trim()) return null;

  const indented = detectIndent(lines, vertical, median);

  // 段落外框偶爾會退化成零面積（缺欄位、或 Vision 自己給了空的框）。
  // 那種情況要退回用字的聯集，否則整個區塊會塌成一個點，貼圖與重排都會錯位。
  const paraBox = boxOf(para.boundingBox);
  const box = (paraBox && paraBox.w > 0 && paraBox.h > 0)
    ? paraBox
    : unionBox(kept.map(w => w.box));

  return {
    vertical,
    bbox: [box.x, box.y, box.w, box.h],
    poly: box.poly || null,
    srcText,
    dstText: null,
    // 重排時的基準字級。直排量寬、橫排量高，這是原書的字身大小
    fontSize: median,
    lines: lines.map(l => ({ text: l.text, bbox: [l.box.x, l.box.y, l.box.w, l.box.h] })),
    kind: 'body',          // M4 會用 Claude 重新分類
    skipTranslate: false,
    indent: indented,      // 原書段首有縮排，重排時要套中文的兩字縮排
  };
}

/**
 * 這一段的段首有沒有縮排？
 *
 * 日文書是一字下げ、中文書是兩字下げ，但這裡只需要判斷「有沒有」——
 * 實際縮多少交給排版層依中文慣例決定。
 *
 * 判斷方式是比較各行的起始位置：直排看頂端、橫排看左緣。
 * 只要有任何一行明顯比最小值晚開始，就當作這一段有縮排。
 * 用「最小值」當基準而不是第一行，因為 OCR 出來的第一行不一定是段首。
 */
function detectIndent(lines, vertical, median) {
  if (lines.length < 2 || !median) return false;

  const starts = lines.map(l => vertical ? l.box.y : l.box.x);
  const base = Math.min(...starts);
  // 至少縮進半個字才算，否則 OCR 的座標誤差會被誤判成縮排
  const threshold = median * 0.5;
  return starts.some(s => s - base >= threshold);
}

/**
 * 直排判定：看相鄰字的位移，垂直方向走得比水平方向多就是直排。
 * 比單純看外框長寬比可靠 —— 一個只有兩三個字的直排標題外框可能是接近正方的。
 */
function detectVertical(words) {
  if (words.length < 2) {
    const b = words[0].box;
    return b.h > b.w * 1.4;
  }
  let dx = 0, dy = 0;
  for (let i = 1; i < words.length; i++) {
    const [x0, y0] = centreOf(words[i - 1].box);
    const [x1, y1] = centreOf(words[i].box);
    dx += Math.abs(x1 - x0);
    dy += Math.abs(y1 - y0);
  }
  return dy > dx;
}

/**
 * 剔除振り仮名。
 * 條件：明顯比主字小、而且整串都是假名。
 *
 * 只靠大小會誤殺小字排版的註解，只靠假名會誤殺純假名的內文，兩個都要。
 * 另外加一道保險：如果要丟掉的字超過整段的四成，那多半是中位數估錯了
 * （例如整段本來就是小字），這種情況一個都不丟。
 */
function stripRuby(words, median, vertical) {
  const threshold = median * 0.62;
  const dropped = [];
  const kept = [];

  for (const w of words) {
    const size = vertical ? w.box.w : w.box.h;
    if (size < threshold && isAllKana(w.text)) dropped.push(w);
    else kept.push(w);
  }

  const droppedChars = dropped.reduce((s, w) => s + w.text.length, 0);
  const totalChars = words.reduce((s, w) => s + w.text.length, 0);
  if (totalChars && droppedChars / totalChars > 0.4) {
    return { kept: words, dropped: [] };
  }
  return { kept, dropped: dropped.map(w => w.text) };
}

/**
 * 把字聚成行（直排時是欄）。
 * 直排：依 x 中心分群，群與群之間由右往左；群內由上往下。
 * 橫排：依 y 中心分群，群與群之間由上往下；群內由左往右。
 */
function groupLines(words, vertical, median) {
  const tolerance = Math.max(median * 0.6, 4);
  const groups = [];

  for (const w of words) {
    const [cx, cy] = centreOf(w.box);
    const key = vertical ? cx : cy;
    let g = groups.find(g => Math.abs(g.key - key) <= tolerance);
    if (!g) {
      g = { key, items: [] };
      groups.push(g);
    }
    g.items.push(w);
    // 群心跟著移動，長行才不會因為輕微傾斜而被切成兩段
    g.key = g.items.reduce((s, it) => s + (vertical ? centreOf(it.box)[0] : centreOf(it.box)[1]), 0) / g.items.length;
  }

  // 直排的欄序是由右往左，這是日文書和中文直排書的共同慣例
  groups.sort((a, b) => vertical ? b.key - a.key : a.key - b.key);

  return groups.map(g => {
    g.items.sort((p, q) => {
      const [px, py] = centreOf(p.box), [qx, qy] = centreOf(q.box);
      return vertical ? py - qy : px - qx;
    });
    return {
      text: joinWords(g.items),
      box: unionBox(g.items.map(w => w.box)),
    };
  });
}

/** 日文詞與詞之間不加空白；只有 Vision 明確標了 SPACE 才補。 */
function joinWords(items) {
  let out = '';
  for (let i = 0; i < items.length; i++) {
    out += items[i].text;
    const br = items[i].lastBreak;
    if ((br === 'SPACE' || br === 'SURE_SPACE') && i < items.length - 1) {
      // 兩邊都沒有漢字或假名時才是真的空白，否則是 Vision 的分詞
      const needsSpace = !RE_HAS_KANJI.test(items[i].text) && !isAllKana(items[i].text);
      if (needsSpace) out += ' ';
    }
  }
  return out;
}

/**
 * 決定整頁的閱讀順序。
 * 直排頁由右往左，同一欄帶內再由上往下；橫排頁由上往下、由左往右。
 */
function orderBlocks(blocks, vertical) {
  if (!blocks.length) return [];

  if (vertical) {
    // 用整頁的中位字級當「同一欄帶」的容差，避免相鄰兩欄被判成同一欄
    const band = medianOf(blocks.map(b => b.fontSize)) * 1.6 || 24;
    return [...blocks].sort((a, b) => {
      const ax = a.bbox[0] + a.bbox[2], bx = b.bbox[0] + b.bbox[2];   // 右緣
      if (Math.abs(ax - bx) > band) return bx - ax;                    // 右邊的先讀
      return a.bbox[1] - b.bbox[1];                                    // 同一帶則上面先讀
    });
  }

  const band = medianOf(blocks.map(b => b.fontSize)) * 1.6 || 24;
  return [...blocks].sort((a, b) => {
    if (Math.abs(a.bbox[1] - b.bbox[1]) > band) return a.bbox[1] - b.bbox[1];
    return a.bbox[0] - b.bbox[0];
  });
}

/* ---------- 小工具 ---------- */

function medianOf(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function unionBox(boxes) {
  const x = Math.min(...boxes.map(b => b.x));
  const y = Math.min(...boxes.map(b => b.y));
  const r = Math.max(...boxes.map(b => b.x + b.w));
  const btm = Math.max(...boxes.map(b => b.y + b.h));
  return { x, y, w: r - x, h: btm - y };
}
