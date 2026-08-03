/* 中文直排的字元規則。
 *
 * 直排不是「把橫排轉九十度」。同一個標點在直排與橫排要放在字格的不同位置，
 * 有些字元本身還得旋轉。這些規則寫錯，整頁會透出一股說不上來的怪異感。
 */

/** 需要旋轉 90° 的字元：橫向的括號、破折號、連字號、波浪號。 */
export const ROTATE = new Set([
  '（', '）', '(', ')', '［', '］', '[', ']', '｛', '｝', '{', '}',
  '〔', '〕', '【', '】', '〖', '〗', '「', '」', '『', '』', '〈', '〉', '《', '》',
  '—', '―', '─', '－', '-', '～', '〜', '~', '…', '‥', '＝', '=', '_', '＿',
]);

/** 直排時需要特別擺位的標點：句號、頓號、逗號。 */
export const VERTICAL_PUNCT = new Set(['。', '、', '，', '．', '.', ',', '｡', '､']);

/**
 * 這些標點在直排時要擺哪裡。
 *
 * 'center'（預設）—— 置中，和其他字一樣正常擺放。
 * 'topRight'      —— 傳統直排排版的做法，擺在字格右上角。
 *
 * 慣例上是 topRight，但那個效果偏傳統書籍的味道，看起來會比較「舊」。
 * 預設改成 center 是刻意的選擇，不是漏做。要切回慣例改這個常數即可。
 */
export const PUNCT_MODE = 'center';

/* CJK 字型裡這些標點的墨水本來就偏在 em 框的左下象限，
   所以「置中」需要往右上各推約四分之一字身，「右上角」則要推約半個字身。 */
const PUNCT_OFFSET = {
  center:   { offsetX: 0.23, offsetY: -0.25 },
  topRight: { offsetX: 0.46, offsetY: -0.5 },
};

/** 置於字格右下角：起始括號旋轉後要靠下。 */
export const OPENING = new Set(['（', '(', '［', '[', '｛', '{', '〔', '【', '〖', '「', '『', '〈', '《']);
export const CLOSING = new Set(['）', ')', '］', ']', '｝', '}', '〕', '】', '〗', '」', '』', '〉', '》']);

/** 行首禁則：這些字元不能出現在一欄的開頭，必須往前一欄推。 */
export const NO_LINE_START = new Set([
  '。', '、', '，', '．', '.', ',', '：', ':', '；', ';', '！', '!', '？', '?',
  '）', ')', '］', ']', '｝', '}', '〕', '】', '〗', '」', '』', '〉', '》',
  'ー', 'ゝ', 'ゞ', 'ヽ', 'ヾ', '々', '〻',
  'ぁ', 'ぃ', 'ぅ', 'ぇ', 'ぉ', 'っ', 'ゃ', 'ゅ', 'ょ', 'ゎ',
  'ァ', 'ィ', 'ゥ', 'ェ', 'ォ', 'ッ', 'ャ', 'ュ', 'ョ', 'ヮ',
  '‥', '…', '·', '・', '％', '%', '℃',
]);

/** 行尾禁則：這些字元不能出現在一欄的結尾，必須推到下一欄。 */
export const NO_LINE_END = new Set([
  '（', '(', '［', '[', '｛', '{', '〔', '【', '〖', '「', '『', '〈', '《',
  '＄', '$', '＃', '#', '＠', '@',
]);

/** 半形數字與字母：直排時要組成縦中横。 */
export const RE_TATECHUYOKO = /^[0-9A-Za-z]$/;

/** 全形標點在直排時佔的實際墨水寬度只有半格，排版時要據此收緊。 */
export const HALF_WIDTH_IN_VERTICAL = new Set([
  '。', '、', '，', '．', '：', '；', '！', '？',
  '（', '）', '「', '」', '『', '』', '〈', '〉', '《', '》', '【', '】', '〔', '〕',
]);

/**
 * 判斷一個字元在直排時要怎麼擺。
 * @returns {{rotate: boolean, offsetX: number, offsetY: number}}
 *   offset 以字身大小為單位（1 = 一個字寬）
 */
export function placement(ch) {
  if (VERTICAL_PUNCT.has(ch)) {
    return { rotate: false, ...PUNCT_OFFSET[PUNCT_MODE] };
  }
  if (ROTATE.has(ch)) {
    if (OPENING.has(ch)) return { rotate: true, offsetX: 0, offsetY: -0.06 };
    if (CLOSING.has(ch)) return { rotate: true, offsetX: 0, offsetY: 0.06 };
    return { rotate: true, offsetX: 0, offsetY: 0 };
  }
  return { rotate: false, offsetX: 0, offsetY: 0 };
}

/**
 * 把字串切成排版單元。
 * 連續的半形數字或字母會被合併成一個縦中横單元，整組橫著擺在一個字格裡。
 * @returns {{text: string, tate: boolean}[]}
 */
export function segment(text) {
  const out = [];
  let buffer = '';

  const flush = () => {
    if (!buffer) return;
    // 三個字以上橫擺會超出字格，那種情況讓它逐字直排比較不難看
    if (buffer.length <= 2) out.push({ text: buffer, tate: true });
    else for (const c of buffer) out.push({ text: c, tate: false });
    buffer = '';
  };

  for (const ch of text) {
    if (RE_TATECHUYOKO.test(ch)) {
      buffer += ch;
      continue;
    }
    flush();
    out.push({ text: ch, tate: false });
  }
  flush();
  return out;
}

/**
 * 禁則處理：調整換欄位置。
 * @param {{text:string}[]} units 一整段的排版單元
 * @param {number} perLine 一欄可容納幾個單元
 * @returns {number[]} 每一欄的起始索引
 */
export function breakLines(units, perLine) {
  if (perLine < 1) return [0];
  const starts = [0];
  let i = 0;

  while (i + perLine < units.length) {
    let cut = i + perLine;   // 預設的換欄位置

    // 行首禁則：下一欄的第一個字不能是句號、收尾括號之類的，把切點往前挪
    let guard = 0;
    while (cut > i + 1 && NO_LINE_START.has(units[cut].text) && guard++ < perLine) cut--;

    // 行尾禁則：這一欄的最後一個字不能是起始括號，同樣往前挪
    guard = 0;
    while (cut > i + 1 && NO_LINE_END.has(units[cut - 1].text) && guard++ < perLine) cut--;

    // 兩條規則互相打架時就放棄調整，硬切總比無限迴圈好
    if (cut <= i) cut = i + perLine;

    starts.push(cut);
    i = cut;
  }
  return starts;
}
