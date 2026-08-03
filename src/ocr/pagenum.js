/* 頁碼判定。
 *
 * 原本這件事完全交給模型判斷，但頁碼很短、又沒有上下文，模型會漏。
 * 漏掉的後果是「一二」被翻成「十二」之類的荒謬結果，而且還花了錢。
 *
 * 所以改成先跑一道確定性規則：符合的直接標成頁碼、不送翻譯。
 * 規則要夠嚴，寧可漏判讓模型接手，也不要把正文誤殺。
 */

/** 只由數字、中日文數字與常見裝飾符號構成。 */
const RE_NUMERIC_ONLY =
  /^[\s\d０-９〇零一二三四五六七八九十百千万萬廿卅\-‐–—―ー・･.。、·「」（）()［］\[\]<>《》〈〉|｜/／*＊]+$/;

/** 頁碼常見的前後綴，例如「第12頁」「- 12 -」「p.12」「ページ 12」。 */
const RE_PAGE_AFFIX = /^(?:p|P|ｐ|Ｐ|page|Page|第|ページ|頁|页)?[\s.．]*[\d０-９〇一二三四五六七八九十百千]+[\s.．]*(?:頁|页|ページ|ﾍﾟｰｼﾞ)?$/;

/* 允許出現在頁碼裡的最大字數。
   即使帶前後綴，「第123頁」是 5 字、「- 456 -」去空白後是 5 字，
   超過 8 字的數字串比較可能是年份、電話或正文裡的列舉。 */
const MAX_CHARS = 8;

/** 距離頁緣多近才算在「版心之外」。 */
const EDGE_RATIO = 0.12;

/**
 * 這一塊看起來像頁碼嗎？
 * @param {{srcText: string, bbox: number[]}} block
 * @param {{width: number, height: number}} page
 * @returns {boolean}
 */
export function looksLikePageNumber(block, page) {
  const text = String(block.srcText || '').replace(/[\s　]+/g, '');
  if (!text) return false;
  if (text.length > MAX_CHARS) return false;

  // 至少要有一個數字字元，純符號的裝飾線不算
  if (!/[\d０-９〇零一二三四五六七八九十百千]/.test(text)) return false;

  if (!RE_NUMERIC_ONLY.test(text) && !RE_PAGE_AFFIX.test(text)) return false;

  const W = page.width || 1, H = page.height || 1;
  const [x, y, w, h] = block.bbox;

  // 必須貼近某一側頁緣。中間的圖號、年份、數量都會因此被排除
  const nearTop = y < H * EDGE_RATIO;
  const nearBottom = (y + h) > H * (1 - EDGE_RATIO);
  const nearLeft = x < W * EDGE_RATIO;
  const nearRight = (x + w) > W * (1 - EDGE_RATIO);
  if (!(nearTop || nearBottom || nearLeft || nearRight)) return false;

  // 還要夠小。整個版心寬的一整行就算貼著頁緣也不會是頁碼
  const areaRatio = (w * h) / (W * H);
  if (areaRatio > 0.06) return false;

  return true;
}

/**
 * 就地標記整頁裡的頁碼。
 * @returns {number} 標記了幾塊
 */
export function markPageNumbers(blocks, page) {
  let n = 0;
  for (const b of blocks) {
    if (b.skipTranslate) continue;
    if (!looksLikePageNumber(b, page)) continue;
    b.kind = 'pagenum';
    b.skipTranslate = true;
    // 這幾類匯出時從原圖裁切貼回，譯文留空是刻意的
    b.dstText = '';
    n++;
  }
  return n;
}
