/* 送給 Claude 的指令與輸出結構。
 *
 * 分類與翻譯合併成同一次請求：一頁一次往返。分開送會讓成本與延遲都加倍，
 * 而且分類本來就需要看懂內容才判斷得準，兩件事拆開反而更糟。
 *
 * 輸出用 tool_choice 強制走結構化 schema，不靠模型自己吐乾淨的 JSON。
 */

export const KINDS = {
  title:      '章節標題或大標',
  body:       '正文',
  caption:    '圖片或表格的說明文字',
  note:       '註解、註釋、譯註、小字補充',
  quote:      '引文、書信、詩句等與正文區隔的段落',
  table:      '表格內的文字',
  figuretext: '印在插圖或照片上的文字，例如招牌、標示、對白框',
  header:     '頁眉、書名側標、章名側標',
  footer:     '頁尾',
  pagenum:    '頁碼',
};

/** 這幾類不送翻譯：改成從原圖裁切貼回，既保留原樣也避開缺字問題。 */
export const NO_TRANSLATE = new Set(['header', 'footer', 'pagenum']);

export const SYSTEM = `你是把日文書籍翻譯成繁體中文的專業譯者，同時負責判讀書頁的版面結構。

## 翻譯原則

- 忠於原文。不增譯、不刪譯、不補充原文沒有的資訊、不加任何譯註或說明。
- 只做「微幅修飾」：把日文語序、助詞、被動與敬語調整成自然的中文語法，
  讓句子讀起來像中文而不是翻譯腔。除此之外不要改寫、不要潤色、不要換說法。
- 使用臺灣的繁體中文用詞與標點（「」為引號，破折號用──）。
- 保留原文的段落與換行結構。原文有幾個換行，譯文就有幾個換行。
- 原文若有明顯的語氣（粗俗、古雅、幼稚、生硬），譯文要保留那個語氣。
- 遇到擬聲擬態語，翻成中文習慣的表達，不要音譯。
- 人名、地名等專有名詞一律照詞彙表；詞彙表沒有的，自己決定一個譯法並回報。

## 版面判讀

依照文字內容與它在頁面上的位置（座標已正規化為 0–1，原點在左上），
判斷每個區塊屬於哪一類：

${Object.entries(KINDS).map(([k, v]) => `- \`${k}\`：${v}`).join('\n')}

判斷要點：
- 位於頁面最上緣或最下緣、字數很少、內容是書名章名或純數字的，多半是
  header / footer / pagenum，不是正文。
- 字級明顯大於其他區塊、獨立成塊、位置靠上的，通常是 title。
- 緊鄰圖片、字級偏小、以「図」「表」「写真」等字開頭的，通常是 caption。
- 標記為「圖內文字」的區塊一律歸為 figuretext。那些字會直接蓋回插圖上，
  空間很有限，譯文要盡量精簡，但仍不可增刪原意。

被判為 header、footer、pagenum 的區塊**不要翻譯**，translation 欄位留空字串。
那些區塊會直接從原始掃描影像裁切貼回，保留原樣。

## 輸出

一律呼叫 submit_page 工具回報結果。每個輸入區塊都要有對應的輸出，id 必須一致。`;

export const TOOL = {
  name: 'submit_page',
  description: '回報這一頁每個區塊的分類與譯文，以及本頁新出現的專有名詞。',
  input_schema: {
    type: 'object',
    properties: {
      blocks: {
        type: 'array',
        description: '與輸入區塊一一對應，順序與數量都要相同。',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '輸入區塊的 id，原樣回傳。' },
            kind: { type: 'string', enum: Object.keys(KINDS) },
            translation: {
              type: 'string',
              description: '繁體中文譯文。header / footer / pagenum 一律留空字串。',
            },
          },
          required: ['id', 'kind', 'translation'],
        },
      },
      glossary: {
        type: 'array',
        description: '本頁新出現、之前詞彙表沒有的專有名詞。沒有就給空陣列。',
        items: {
          type: 'object',
          properties: {
            ja: { type: 'string', description: '日文原文' },
            zh: { type: 'string', description: '採用的中文譯法' },
            note: { type: 'string', description: '類別，例如 人名／地名／作品名／術語' },
          },
          required: ['ja', 'zh'],
        },
      },
    },
    required: ['blocks'],
  },
};

/**
 * 組出使用者訊息。
 * @param {object[]} blocks 這一頁的文字塊
 * @param {{width:number,height:number}} size 頁面尺寸，用來正規化座標
 * @param {object[]} glossary 已累積的專有名詞
 * @param {{bookName?: string, pageNo?: number, vertical?: boolean, tail?: string}} ctx
 */
export function buildUserMessage(blocks, size, glossary, ctx = {}) {
  const parts = [];
  const carried = new Set(ctx.carriedIds || []);

  if (ctx.bookName) parts.push(`書名：${ctx.bookName}`);
  if (ctx.pageNo != null) parts.push(`這是第 ${ctx.pageNo} 頁。`);
  parts.push(`原書排版方向：${ctx.vertical ? '直排（由右往左）' : '橫排'}`);

  if (glossary?.length) {
    parts.push('\n## 專有名詞對照表（必須遵守）\n');
    parts.push(glossary.map(g =>
      `- ${g.ja} → ${g.zh}${g.note ? `（${g.note}）` : ''}`).join('\n'));
  }

  if (ctx.tail) {
    parts.push('\n## 上一頁結尾（僅供銜接語氣與代名詞，不要翻譯這段）\n');
    parts.push(ctx.tail);
  }

  if (carried.size) {
    parts.push(
      '\n## 跨頁的段落\n' +
      '標記為「接續下一頁」的區塊，內容在原書裡和本頁最後一段是同一個句子或段落，' +
      '只是被印在下一頁的開頭。\n' +
      '請把它們**當成同一段一起理解後再翻譯**，各自回傳自己那一段對應的譯文。\n' +
      '不要把下一頁的內容併進本頁的區塊，也不要重複翻譯同一段話。');
  }

  parts.push('\n## 本頁區塊\n');
  parts.push('座標為 [左, 上, 寬, 高]，已正規化到 0–1，原點在頁面左上角。\n');

  const w = size.width || 1, h = size.height || 1;
  parts.push(blocks.map(b => {
    const [x, y, bw, bh] = b.bbox;
    const box = [x / w, y / h, bw / w, bh / h].map(v => v.toFixed(3)).join(', ');
    const size_ = (b.fontSize / h).toFixed(4);
    const flags = [
      b.vertical ? '直排' : '橫排',
      carried.has(b.id) ? '**接續下一頁**' : '',
    ].filter(Boolean).join('　');
    return [
      `### ${b.id}`,
      `座標 [${box}]　相對字高 ${size_}　${flags}`,
      b.srcText,
    ].join('\n');
  }).join('\n\n'));

  return parts.join('\n');
}

/* ---------- 跨頁段落的判定 ---------- */

/** 句子結束的標記。缺了這些就代表話還沒說完。 */
const TERMINAL = /[。！？!?」』）\)】〕》〉…]\s*$/;

/** 這幾類本來就是獨立的短句，不該跨頁相連。 */
const NON_FLOWING = new Set(['title', 'header', 'footer', 'pagenum', 'caption', 'figuretext', 'table']);

/**
 * 上一段是否延續到下一段？
 * 只看標點：日文句子的動詞在句尾，沒有句號就代表話沒說完。
 */
export function flowsInto(prev, next) {
  if (!prev || !next) return false;
  if (NON_FLOWING.has(prev.kind) || NON_FLOWING.has(next.kind)) return false;
  if (prev.skipTranslate || next.skipTranslate) return false;

  const tail = String(prev.srcText || '').replace(/[\s　]+$/, '');
  if (!tail) return false;
  if (TERMINAL.test(tail)) return false;

  // 下一段若以起始括號開頭，多半是新的一句對白，不是接續
  if (/^[「『（(【〔《〈]/.test(String(next.srcText || '').trim())) return false;
  return true;
}

/** 粗估這一頁要多少 token，用來事前顯示費用。 */
export function estimateTokens(blocks, glossary = []) {
  const chars = blocks.reduce((s, b) => s + b.srcText.length, 0);
  const gloss = glossary.reduce((s, g) => s + g.ja.length + g.zh.length + 8, 0);
  // 日文與中文大約 1 字 ≈ 1 token；再加上系統指令與結構化輸出的額外開銷
  const input = Math.round(chars * 1.1 + gloss + 900);
  const output = Math.round(chars * 1.2 + 120);
  return { input, output };
}

/* 每百萬 token 的美金單價，用於事前估算。定價會變動，這裡只求量級正確。 */
const PRICE = {
  'claude-opus-5':   { in: 5,    out: 25 },
  'claude-sonnet-5': { in: 3,    out: 15 },
};

export function estimateCost(model, { input, output }) {
  const p = PRICE[model] || PRICE['claude-sonnet-5'];
  return (input / 1e6) * p.in + (output / 1e6) * p.out;
}

/* ---------- Gemini ---------- */

/**
 * 把 Claude 的 input_schema 轉成 Gemini 的 responseSchema。
 * 兩邊都是 JSON Schema 的子集，但 Gemini 走 OpenAPI 的型別列舉，型別名稱要大寫，
 * 而且只認得少數幾個關鍵字，多餘的欄位會讓請求整個被拒。
 */
export function toGeminiSchema(node) {
  if (!node || typeof node !== 'object') return node;

  const out = {};
  if (node.type) out.type = String(node.type).toUpperCase();
  if (node.description) out.description = node.description;
  if (node.enum) out.enum = node.enum;

  if (node.properties) {
    out.properties = Object.fromEntries(
      Object.entries(node.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
    // Gemini 不保證欄位順序，明確指定可讓輸出穩定一點
    out.propertyOrdering = Object.keys(node.properties);
  }
  if (node.items) out.items = toGeminiSchema(node.items);
  if (node.required) out.required = node.required;

  return out;
}

/** 送給 Gemini 的輸出結構，等同 Claude 那邊的 TOOL.input_schema。 */
export const GEMINI_SCHEMA = toGeminiSchema(TOOL.input_schema);

/** Gemini 沒有工具呼叫這一層，指令要多說一句輸出格式。 */
export const GEMINI_SYSTEM = SYSTEM.replace(
  '一律呼叫 submit_page 工具回報結果。每個輸入區塊都要有對應的輸出，id 必須一致。',
  '直接輸出符合指定結構的 JSON，不要包在程式碼圍欄裡，不要加任何說明文字。\n' +
  '每個輸入區塊都要有對應的輸出，id 必須一致。');
