/* 一頁的翻譯流程：分類 + 翻譯 + 收詞彙，一次往返。 */

import * as db from '../state/db.js';
import { settings } from '../state/settings.js';
import { messages, ClaudeError } from '../api/claude.js';
import { SYSTEM, TOOL, NO_TRANSLATE, buildUserMessage, estimateTokens, estimateCost } from './prompt.js';
import * as glossary from './glossary.js';

/**
 * 翻譯一頁。
 * @param {object} page
 * @param {{force?: boolean, signal?: AbortSignal, bookName?: string, tail?: string}} opts
 */
export async function translatePage(page, opts = {}) {
  const blocks = (await db.getBy('blocks', 'pageId', page.id))
    .sort((a, b) => a.order - b.order);

  if (!blocks.length) throw new Error('這一頁還沒有辨識出文字，請先執行辨識');

  const pending = opts.force ? blocks : blocks.filter(b => b.dstText == null && !b.skipTranslate);
  if (!pending.length) return { blocks, translated: 0, cost: 0, usage: null };

  const terms = glossary.trim(await glossary.load(page.projectId));

  const width = page.procW || page.origW;
  const height = page.procH || page.origH;

  const userMessage = buildUserMessage(pending, { width, height }, terms, {
    bookName: opts.bookName,
    pageNo: page.index + 1,
    vertical: page.vertical,
    tail: opts.tail,
  });

  const res = await messages({
    max_tokens: 8000,
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: 'tool', name: TOOL.name },
    messages: [{ role: 'user', content: userMessage }],
  }, { signal: opts.signal });

  const call = res.content?.find(c => c.type === 'tool_use' && c.name === TOOL.name);
  if (!call) throw new ClaudeError('模型沒有回傳結構化結果，請重試', 200, res.stop_reason);

  const byId = new Map(blocks.map(b => [b.id, b]));
  const writes = [];
  let translated = 0;

  for (const item of call.input.blocks || []) {
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
  const returned = new Set((call.input.blocks || []).map(b => b.id));
  for (const b of pending) {
    if (!returned.has(b.id)) {
      b.dstText = null;
      b.error = '模型沒有回傳這一塊的譯文';
      writes.push(b);
    }
  }

  if (writes.length) await db.putMany('blocks', writes);

  const gloss = await glossary.merge(page.projectId, call.input.glossary || []);

  const missing = writes.filter(b => b.error).length;
  await db.put('pages', {
    ...page,
    status: missing ? 'failed' : 'translated',
    error: missing ? `有 ${missing} 個區塊沒有譯文` : null,
  });

  return {
    blocks: writes,
    translated,
    glossary: gloss,
    usage: res.usage,
    cost: costOf(res.usage),
  };
}

function costOf(usage) {
  if (!usage) return 0;
  return estimateCost(settings.model, {
    input: usage.input_tokens || 0,
    output: usage.output_tokens || 0,
  });
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

  const res = await messages({
    max_tokens: 4000,
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: 'tool', name: TOOL.name },
    messages: [{ role: 'user', content: user }],
  }, { signal });

  const call = res.content?.find(c => c.type === 'tool_use' && c.name === TOOL.name);
  const item = call?.input?.blocks?.[0];
  if (!item) throw new ClaudeError('模型沒有回傳結果，請重試', 200);

  const next = {
    ...block,
    kind: item.kind || block.kind,
    skipTranslate: NO_TRANSLATE.has(item.kind || block.kind),
    dstText: NO_TRANSLATE.has(item.kind || block.kind) ? '' : (item.translation ?? ''),
    error: null,
  };
  await db.put('blocks', next);
  await glossary.merge(block.projectId, call.input.glossary || []);

  return { block: next, cost: costOf(res.usage), usage: res.usage };
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
  return {
    blockCount,
    input, output,
    cost: estimateCost(settings.model, { input, output }),
  };
}
