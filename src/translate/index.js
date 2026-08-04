/* 一頁的翻譯流程：分類 + 翻譯 + 收詞彙，一次往返。 */

import * as db from '../state/db.js';
import { settings } from '../state/settings.js';
import { messages, ClaudeError } from '../api/claude.js';
import * as gemini from '../api/gemini.js';
import {
  SYSTEM, TOOL, NO_TRANSLATE, buildUserMessage, estimateTokens, estimateCost,
  GEMINI_SYSTEM, GEMINI_SCHEMA, flowsInto,
} from './prompt.js';
import * as glossary from './glossary.js';
import { markPageNumbers } from '../ocr/pagenum.js';

/**
 * 兩家供應商的差異只在這一層：送出去、拿回結構化結果、回報用量。
 * 上層的分類、詞彙表、錯誤處理完全共用。
 *
 * @returns {Promise<{result: object, usage: object, cost: number}>}
 *   result 的形狀為 { blocks: [...], glossary: [...] }
 */
async function askModel(userMessage, { maxTokens = 8000, signal } = {}) {
  if (settings.provider === 'gemini') {
    const r = await gemini.generate({
      system: GEMINI_SYSTEM,
      user: userMessage,
      schema: GEMINI_SCHEMA,
      maxOutputTokens: maxTokens,
    }, { signal });

    const result = gemini.parseJson(r.text);
    if (!result || !Array.isArray(result.blocks)) {
      throw new gemini.GeminiError('模型沒有回傳合乎結構的結果，請重試', 200);
    }

    const p = gemini.priceOf(settings.geminiModel);
    const input = r.usage?.promptTokenCount || 0;
    const output = r.usage?.candidatesTokenCount || 0;
    return {
      result,
      usage: { input_tokens: input, output_tokens: output },
      cost: (input / 1e6) * p.in + (output / 1e6) * p.out,
    };
  }

  const res = await messages({
    max_tokens: maxTokens,
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: 'tool', name: TOOL.name },
    messages: [{ role: 'user', content: userMessage }],
  }, { signal });

  const call = res.content?.find(c => c.type === 'tool_use' && c.name === TOOL.name);
  if (!call) throw new ClaudeError('模型沒有回傳結構化結果，請重試', 200, res.stop_reason);

  return {
    result: call.input,
    usage: res.usage,
    cost: estimateCost(settings.model, {
      input: res.usage?.input_tokens || 0,
      output: res.usage?.output_tokens || 0,
    }),
  };
}

/** 目前供應商的模型代號，用於顯示與費用估算。 */
export function currentModel() {
  return settings.provider === 'gemini' ? settings.geminiModel : settings.model;
}

/** 目前供應商是否已備妥金鑰。 */
export function providerReady() {
  return settings.provider === 'gemini'
    ? Boolean(gemini.keyOf())
    : Boolean(settings.claudeKey);
}

/**
 * 翻譯一頁。
 * @param {object} page
 * @param {{force?: boolean, signal?: AbortSignal, bookName?: string, tail?: string}} opts
 */
export async function translatePage(page, opts = {}) {
  const blocks = (await db.getBy('blocks', 'pageId', page.id))
    .sort((a, b) => a.order - b.order);

  if (!blocks.length) throw new Error('這一頁還沒有辨識出文字，請先執行辨識');

  const width = page.procW || page.origW;
  const height = page.procH || page.origH;

  /* 再擋一次頁碼。辨識時已經擋過，但這頁可能是在加上這道規則之前就辨識完的，
     那些舊資料若不處理仍會被送去翻譯。 */
  const marked = markPageNumbers(blocks, { width, height });
  if (marked) await db.putMany('blocks', blocks.filter(b => b.kind === 'pagenum'));

  const pending = opts.force ? blocks : blocks.filter(b => b.dstText == null && !b.skipTranslate);
  if (!pending.length) return { blocks, translated: 0, cost: 0, usage: null };

  const terms = glossary.trim(await glossary.load(page.projectId));

  /* 句子被印到下一頁時，把下一頁開頭那一段一起送進來翻。
     否則模型看到的是半句話：它可能自作主張補完，而下一頁又會再翻一次同樣的內容。
     借過來的區塊會直接寫入它自己那一頁，等輪到那一頁時就會被當成已完成而跳過。 */
  const carried = await carryOver(page, pending, opts);
  const outgoing = carried.length ? [...pending, ...carried] : pending;

  const userMessage = buildUserMessage(outgoing, { width, height }, terms, {
    bookName: opts.bookName,
    pageNo: page.index + 1,
    vertical: page.vertical,
    tail: opts.tail,
    carriedIds: carried.map(b => b.id),
  });

  const { result, usage, cost } = await askModel(userMessage, { signal: opts.signal });

  const byId = new Map([...blocks, ...carried].map(b => [b.id, b]));
  const writes = [];
  let translated = 0;

  for (const item of result.blocks || []) {
    const block = byId.get(item.id);
    if (!block) continue;   // 模型偶爾會捏造 id，忽略即可

    const kind = item.kind || 'body';
    const skip = NO_TRANSLATE.has(kind);

    block.kind = kind;
    block.skipTranslate = skip;
    // 這幾類改成從原圖裁切貼回，譯文留空是刻意的
    block.dstText = skip ? '' : (item.translation ?? '');
    writes.push(block);
    if (!skip && block.dstText) translated++;
  }

  // 模型漏掉的區塊不能就這樣消失，標記出來讓使用者看得到
  const returned = new Set((result.blocks || []).map(b => b.id));
  for (const b of outgoing) {
    if (!returned.has(b.id)) {
      b.dstText = null;
      b.error = '模型沒有回傳這一塊的譯文';
      writes.push(b);
    }
  }

  if (writes.length) await db.putMany('blocks', writes);

  const gloss = await glossary.merge(page.projectId, result.glossary || []);

  // 借過來的區塊屬於下一頁，本頁的完成度不該被它影響
  const mine = new Set(blocks.map(b => b.id));
  const missing = writes.filter(b => b.error && mine.has(b.id)).length;
  await db.put('pages', {
    ...page,
    status: missing ? 'failed' : 'translated',
    error: missing ? `有 ${missing} 個區塊沒有譯文` : null,
  });

  return { blocks: writes, translated, carried: carried.length, glossary: gloss, usage, cost };
}

/**
 * 找出「本頁最後一段還沒說完、接到下一頁開頭」的情況，
 * 把下一頁那一段借過來一起翻。
 *
 * 只借一段：借太多會讓單次請求變大，而且連續三頁以上的長段落
 * 會在下一頁自己再借一次，效果一樣。
 */
async function carryOver(page, pending, opts) {
  if (opts.noCarry || !pending.length) return [];

  const last = pending[pending.length - 1];
  if (!last || last.skipTranslate) return [];

  const siblings = (await db.getBy('pages', 'projectId', page.projectId))
    .sort((a, b) => a.index - b.index);
  const next = siblings.find(p => p.index === page.index + 1);
  if (!next) return [];

  const nextBlocks = (await db.getBy('blocks', 'pageId', next.id))
    .sort((a, b) => a.order - b.order);
  const first = nextBlocks.find(b => !b.skipTranslate);

  // 已經翻過的不要再動：可能是使用者手動改過或先前借過去的
  if (!first || first.dstText != null) return [];
  if (!flowsInto(last, first)) return [];

  return [first];
}

/** 取這一頁末尾的正文，當作下一頁的銜接上下文。 */
export async function tailOf(page, chars = 200) {
  const blocks = (await db.getBy('blocks', 'pageId', page.id))
    .filter(b => b.kind === 'body' && b.srcText)
    .sort((a, b) => a.order - b.order);
  if (!blocks.length) return '';
  const text = blocks[blocks.length - 1].srcText.replace(/\n/g, '');
  return text.slice(-chars);
}

/**
 * 依序翻譯多頁。刻意用序列而非平行：
 * 詞彙表要靠前一頁的結果累積，平行跑會讓同一個人名在不同頁各自決定譯法。
 */
export async function translatePages(pages, opts = {}) {
  const out = { done: 0, failed: 0, cost: 0, translated: 0, errors: [] };
  let tail = '';

  for (const page of pages) {
    if (opts.signal?.aborted) break;
    try {
      const r = await translatePage(page, { ...opts, tail });
      out.cost += r.cost;
      out.translated += r.translated;
      out.done++;
      tail = await tailOf(page);
    } catch (e) {
      out.failed++;
      out.errors.push({ page: page.index + 1, message: e.message });
      await db.put('pages', { ...page, status: 'failed', error: e.message });
      tail = '';
    }
    opts.onProgress?.(out.done + out.failed, pages.length, out);
    await new Promise(r => setTimeout(r, 0));
  }
  return out;
}

/** 重跑單一區塊，可附一句額外指示。 */
export async function retranslateBlock(block, { instruction = '', signal } = {}) {
  const page = await db.get('pages', block.pageId);
  const terms = glossary.trim(await glossary.load(block.projectId));

  const width = page.procW || page.origW;
  const height = page.procH || page.origH;

  let user = buildUserMessage([block], { width, height }, terms, {
    pageNo: page.index + 1,
    vertical: page.vertical,
  });
  if (instruction) {
    user += `\n\n## 這一塊的額外指示\n${instruction}`;
  }

  const { result, usage, cost } = await askModel(user, { maxTokens: 4000, signal });
  const item = result.blocks?.[0];
  if (!item) throw new ClaudeError('模型沒有回傳結果，請重試', 200);

  const next = {
    ...block,
    kind: item.kind || block.kind,
    skipTranslate: NO_TRANSLATE.has(item.kind || block.kind),
    dstText: NO_TRANSLATE.has(item.kind || block.kind) ? '' : (item.translation ?? ''),
    error: null,
  };
  await db.put('blocks', next);
  await glossary.merge(block.projectId, result.glossary || []);

  return { block: next, cost, usage };
}

/** 事前估算整批的花費，給確認對話框用。 */
export async function estimateBatch(pages) {
  let input = 0, output = 0, blockCount = 0;
  const projectId = pages[0]?.projectId;
  const terms = projectId ? glossary.trim(await glossary.load(projectId)) : [];

  for (const page of pages) {
    const blocks = (await db.getBy('blocks', 'pageId', page.id))
      .filter(b => b.dstText == null && !b.skipTranslate);
    if (!blocks.length) continue;
    blockCount += blocks.length;
    const t = estimateTokens(blocks, terms);
    input += t.input;
    output += t.output;
  }
  let cost;
  if (settings.provider === 'gemini') {
    const p = gemini.priceOf(settings.geminiModel);
    cost = (input / 1e6) * p.in + (output / 1e6) * p.out;
  } else {
    cost = estimateCost(settings.model, { input, output });
  }
  return { blockCount, input, output, cost, model: currentModel() };
}
