/* EPUB 的分頁。
 *
 * EPUB 沒有原始座標，所以這裡自己造一套書籍版式：固定開本、固定天地左右邊距，
 * 段落依序流進欄位，滿了就換頁。產出的 page / block 形狀和掃描那條路完全一樣，
 * 所以翻譯與 PDF 匯出可以原封不動地共用。
 *
 * 分頁會做兩次：匯入時用日文原文先排一次（讓使用者馬上看得到結構），
 * 翻譯完再依中譯重排一次。中文字數約為日文的 0.6–0.8 倍，
 * 只用原文排的話每頁都會留下大片空白。
 */

import * as db from '../state/db.js';

/** A5 比例、150dpi 左右的像素尺寸。單位和掃描頁一致，都是影像像素。 */
export const PAGE = { width: 1000, height: 1414 };

const MARGIN = { top: 0.075, bottom: 0.085, left: 0.09, right: 0.09 };
const BODY_SIZE = 34;
const TITLE_SIZE = 52;
const COL_GAP = 0.3;      // 欄距，以字身為單位

function area() {
  const x = PAGE.width * MARGIN.left;
  const y = PAGE.height * MARGIN.top;
  return {
    x, y,
    w: PAGE.width * (1 - MARGIN.left - MARGIN.right),
    h: PAGE.height * (1 - MARGIN.top - MARGIN.bottom),
  };
}

/**
 * 把段落流成頁。
 * @param {{kind:string, text:string, indent:boolean, srcText?:string, id?:string}[]} items
 * @returns {{blocks: object[]}[]} 每一頁的區塊，座標已算好
 */
export function paginate(items) {
  const box = area();
  const pages = [];

  let page = null;
  let col = 0;                       // 目前用到第幾欄（從右邊數）

  const startPage = () => {
    page = { blocks: [] };
    pages.push(page);
    col = 0;
  };

  /* 用明確的佇列而不是在 for...of 途中改陣列：
     段落跨頁時要把剩餘的部分排回去繼續處理，邊迭代邊 splice 很容易出錯。 */
  const queue = items.map(it => ({ ...it }));

  while (queue.length) {
    const item = queue.shift();
    const chars = [...String(item.text || '')];
    if (!chars.length) continue;

    const size = item.kind === 'title' ? TITLE_SIZE : BODY_SIZE;
    const colWidth = size * (1 + COL_GAP);
    const perCol = Math.max(1, Math.floor(box.h * 0.98 / size));
    const colsPerPage = Math.max(1, Math.floor(box.w / colWidth));

    const indent = item.indent ? 2 : 0;
    const firstCol = Math.max(1, perCol - indent);
    // 需要幾欄。第一欄被縮排吃掉兩格，所以要分開算
    const needed = chars.length <= firstCol
      ? 1
      : 1 + Math.ceil((chars.length - firstCol) / perCol);

    if (!page) startPage();

    // 標題不跨頁：放不下就整個推到下一頁，免得章名被切成兩半
    if (item.kind === 'title' && col + needed > colsPerPage && col > 0) startPage();
    else if (col >= colsPerPage) startPage();

    const take = Math.min(needed, colsPerPage - col);

    /* 這一塊實際排得下多少字。
       之前這裡存的是整段全文而只把剩餘部分交給下一塊，等於把跨頁的段落
       複製了一份 —— 重排時文字總量會愈滾愈多，頁數不減反增。 */
    const capacity = firstCol + Math.max(0, take - 1) * perCol;
    const head = chars.slice(0, capacity).join('');
    const tail = chars.slice(capacity).join('');

    // 欄從右往左推進
    const x = box.x + box.w - (col + take) * colWidth;

    /* item.text 在兩種情境下代表不同東西：
       首次分頁時是日文原文，翻譯後重排時是中譯。分清楚才不會把中文
       當成「原文」顯示在單頁檢視裡。 */
    const isTranslated = item.dstText != null;

    page.blocks.push({
      kind: item.kind,
      vertical: true,
      bbox: [x, box.y, take * colWidth, box.h],
      fontSize: size,
      indent: Boolean(item.indent),
      // 跨頁的第二段之後對不回原文，寧可留空也不要標錯
      srcText: isTranslated ? (item.srcText || '') : head,
      dstText: isTranslated ? head : null,
      skipTranslate: false,
      lines: [],
      poly: null,
    });

    col += take;

    if (tail) {
      // 這一段還沒排完，剩下的從下一頁繼續，且不再縮排（它不是段首）
      startPage();
      queue.unshift({ ...item, text: tail, srcText: '', indent: false });
    }
  }

  return pages;
}

/**
 * 建立 EPUB 專案的頁面與區塊。
 * @param {string} projectId
 * @param {{chapters: {title:string, paragraphs:object[]}[]}} book
 */
export async function buildPages(projectId, book) {
  const items = [];
  for (const ch of book.chapters) {
    for (const p of ch.paragraphs) {
      items.push({ kind: p.kind, text: p.text, indent: p.indent });
    }
  }
  if (!items.length) throw new Error('這個 EPUB 沒有抽出任何文字');

  const laid = paginate(items);

  const pages = [];
  const blocks = [];

  laid.forEach((p, i) => {
    const pageId = db.uid('pg_');
    pages.push({
      id: pageId,
      projectId,
      index: i,
      status: 'ocr',            // EPUB 不需要辨識，直接進入待翻譯
      source: 'epub',
      origBlob: null,           // 沒有掃描影像，這條路是純文字重排
      origW: PAGE.width,
      origH: PAGE.height,
      procBlob: null,
      procW: PAGE.width,
      procH: PAGE.height,
      corners: null,
      vertical: true,
      nativeText: null,
      error: null,
      createdAt: Date.now(),
    });

    p.blocks.forEach((b, order) => {
      blocks.push({ ...b, id: db.uid('bk_'), pageId, projectId, order });
    });
  });

  await db.putMany('pages', pages);
  await db.putMany('blocks', blocks);
  return { pages: pages.length, blocks: blocks.length };
}

/**
 * 翻譯完之後依中譯重排。
 * 中文比日文短，用原文排出來的版面每頁都會留下大片空白。
 */
export async function repaginate(projectId) {
  const pages = (await db.getBy('pages', 'projectId', projectId))
    .sort((a, b) => a.index - b.index);
  if (!pages.some(p => p.source === 'epub')) return null;

  const all = [];
  for (const p of pages) {
    const bs = (await db.getBy('blocks', 'pageId', p.id)).sort((a, b) => a.order - b.order);
    for (const b of bs) all.push(b);
  }
  // 還沒翻完就重排會把已排好的版面弄亂，不如等全部翻完
  if (!all.length || all.some(b => b.dstText == null && !b.skipTranslate)) return null;

  const items = all.map(b => ({
    kind: b.kind,
    text: b.dstText || b.srcText,
    dstText: b.dstText,
    indent: b.indent,
    srcText: b.srcText,
  }));

  const laid = paginate(items);

  // 舊的頁面與區塊全部換掉
  for (const p of pages) await db.delBy('blocks', 'pageId', p.id);
  await db.delBy('pages', 'projectId', projectId);

  const newPages = [];
  const newBlocks = [];
  laid.forEach((p, i) => {
    const pageId = db.uid('pg_');
    newPages.push({
      ...pages[0], id: pageId, index: i, status: 'translated',
      origBlob: null, procBlob: null,
      origW: PAGE.width, origH: PAGE.height,
      procW: PAGE.width, procH: PAGE.height,
      source: 'epub', vertical: true, error: null,
    });
    p.blocks.forEach((b, order) => {
      newBlocks.push({ ...b, id: db.uid('bk_'), pageId, projectId, order });
    });
  });

  await db.putMany('pages', newPages);
  await db.putMany('blocks', newBlocks);
  return { pages: newPages.length };
}
