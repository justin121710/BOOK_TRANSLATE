/* 行內公式的偵測與佔位符。
 *
 * 句子裡夾的 F_max、x²、σᵢ 這種東西有兩個麻煩：
 *
 *  1. 文字層留不住上下標。Vision 會把 x² 讀成 x2、F_max 讀成 Fmax，
 *     那個「小一號而且抬高」的資訊只存在字元的座標裡。
 *  2. 送進翻譯很危險。模型可能把變數名當成日文詞去翻，或自作主張改寫。
 *
 * 作法是把偵測到的公式片段從原文抽走，換成 ⟦M1⟧ 這樣的佔位符：
 * 模型碰不到公式內容，而佔位符在中文句子裡該擺哪裡是模型判斷的 ——
 * 這比硬套原始像素座標正確，因為中文的字數和語序都和日文不同。
 *
 * 排版時佔位符再換回那一小塊裁切圖，所以形狀是像素級精確的。
 */

/** 佔位符長這樣。用不會出現在日文書裡的括號，避免和內文撞號。 */
const OPEN = '⟦', CLOSE = '⟧';
export const RE_PLACEHOLDER = /⟦M(\d+)⟧/g;

export const makeToken = (i) => `${OPEN}M${i}${CLOSE}`;

/* 可能出現在數學片段裡的字元 */
const RE_MATHY = /[A-Za-zΑ-Ωα-ω0-9]/;
const RE_OPERATOR = /[=＝+＋\-−×÷／/±∓≒≈≠≦≤≧≥<>∑∏∫√∞∂∇°′″·・^_]/;
const RE_GREEK = /[Α-Ωα-ω]/;
/* 這些是日文，遇到就代表公式結束了 */
const RE_JA = /[぀-ヿ一-鿿々〆ヵヶ]/;

/**
 * 從一行字裡找出行內公式的片段。
 *
 * 判定刻意訂嚴：把「1923年」「PDF」「第3章」誤切成圖片，
 * 比漏掉一個公式更糟 —— 前者會讓一句正常的中文中間突然插進一張圖。
 * 所以除了「由英數字構成」之外，還要求至少有一項數學特徵：
 * 偵測到上標或下標、含運算子、或含希臘字母。
 *
 * @param {{text:string, box:object}[]} words 一行的字（含字元級座標）
 * @returns {{text:string, start:number, end:number, bbox:number[]}[]}
 *   start/end 是在該行文字裡的字元索引
 */
export function findMathRuns(words) {
  // 攤平成字元序列，同時記住每個字在行內文字的位置
  const glyphs = [];
  for (const w of words || []) {
    const items = w.glyphs?.length
      ? w.glyphs
      : [...String(w.text || '')].map(ch => ({ text: ch, box: w.box }));
    for (const g of items) glyphs.push(g);
  }
  if (glyphs.length < 1) return [];

  // 主字大小與基線，用中位數才不會被上下標本身拉走
  const heights = glyphs.map(g => g.box.h).filter(Boolean).sort((a, b) => a - b);
  const bottoms = glyphs.map(g => g.box.y + g.box.h).sort((a, b) => a - b);
  if (!heights.length) return [];
  const hMed = heights[heights.length >> 1];
  const bMed = bottoms[bottoms.length >> 1];

  const runs = [];
  let cur = null;
  let index = 0;

  const flush = () => {
    if (cur && qualifies(cur, hMed, bMed)) runs.push(cur);
    cur = null;
  };

  for (const g of glyphs) {
    const ch = g.text;
    const len = [...ch].length;

    const mathy = RE_MATHY.test(ch) || RE_OPERATOR.test(ch);
    // 公式中間的空白不該把它切斷（「a = b」）
    const spacer = /^[\s　]$/.test(ch) && cur;

    if (RE_JA.test(ch) || (!mathy && !spacer)) {
      flush();
      index += len;
      continue;
    }

    if (!cur) cur = { start: index, end: index, text: '', glyphs: [] };
    cur.text += ch;
    cur.glyphs.push(g);
    cur.end = index + len;
    index += len;
  }
  flush();

  return runs.map(r => ({
    text: r.text.trim(),
    start: r.start,
    end: r.end,
    bbox: unionOf(r.glyphs.map(g => g.box)),
  })).filter(r => r.text);
}

/**
 * 這個片段真的是公式嗎？
 * 光是「由英數字組成」不夠 —— 年份、型號、英文縮寫都符合那個條件。
 */
function qualifies(run, hMed, bMed) {
  const text = run.text.trim();
  if (!text) return false;
  // 單一個英數字元多半是列點編號或雜訊，除非它是希臘字母
  if (text.length < 2 && !RE_GREEK.test(text)) return false;

  if (RE_GREEK.test(text)) return true;
  if (RE_OPERATOR.test(text)) return true;

  // 有沒有明顯小一號、而且基線偏移的字元？那就是上標或下標
  return run.glyphs.some(g => {
    if (g.box.h >= hMed * 0.8) return false;
    const bottom = g.box.y + g.box.h;
    const shift = bottom - bMed;
    return Math.abs(shift) >= hMed * 0.12;
  });
}

function unionOf(boxes) {
  const x = Math.min(...boxes.map(b => b.x));
  const y = Math.min(...boxes.map(b => b.y));
  return [
    x, y,
    Math.max(...boxes.map(b => b.x + b.w)) - x,
    Math.max(...boxes.map(b => b.y + b.h)) - y,
  ];
}

/**
 * 就地把區塊裡的公式換成佔位符。
 * @param {object} block 由 parse.js 產出的區塊（lines 需帶 words）
 * @returns {number} 找到幾個公式
 */
export function extractMath(block) {
  if (!block?.lines?.length) return 0;

  const spans = [];
  const outLines = [];

  for (const line of block.lines) {
    const runs = findMathRuns(line.words);
    if (!runs.length) { outLines.push(line.text); continue; }

    const chars = [...line.text];
    let out = '';
    let at = 0;
    for (const r of runs) {
      // 座標來自 OCR、文字索引來自組出來的字串，兩者可能對不齊，對不上就跳過
      if (r.start < at || r.end > chars.length) continue;
      out += chars.slice(at, r.start).join('');
      out += makeToken(spans.length + 1);
      spans.push({ id: spans.length + 1, src: r.text, bbox: r.bbox });
      at = r.end;
    }
    out += chars.slice(at).join('');
    outLines.push(out);
  }

  if (!spans.length) return 0;

  block.srcText = outLines.join('\n');
  block.mathSpans = spans;
  return spans.length;
}

/** 把佔位符換回原始文字，用於顯示與「取消公式」。 */
export function inlineMath(text, spans) {
  if (!spans?.length) return String(text || '');
  const byId = new Map(spans.map(s => [s.id, s]));
  return String(text || '').replace(RE_PLACEHOLDER,
    (m, n) => byId.get(Number(n))?.src ?? m);
}

/**
 * 把含佔位符的字串切成「文字」與「公式」兩種片段，給排版層用。
 * @returns {{text?:string, math?:object}[]}
 */
export function splitByMath(text, spans) {
  const s = String(text || '');
  if (!spans?.length) return [{ text: s }];

  const byId = new Map(spans.map(x => [x.id, x]));
  const out = [];
  let at = 0;

  for (const m of s.matchAll(RE_PLACEHOLDER)) {
    const span = byId.get(Number(m[1]));
    if (!span) continue;
    if (m.index > at) out.push({ text: s.slice(at, m.index) });
    out.push({ math: span });
    at = m.index + m[0].length;
  }
  if (at < s.length) out.push({ text: s.slice(at) });
  return out.length ? out : [{ text: s }];
}
