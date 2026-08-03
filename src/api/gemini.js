/* Google Gemini。
 *
 * 走 generativelanguage.googleapis.com，和 Cloud Vision 同一個 Google Cloud 專案，
 * 所以可以共用同一把 API 金鑰 —— 前提是那把金鑰的 API 限制要加上
 * 「Generative Language API」。共用之後就不必再管 Anthropic 那把金鑰，
 * 而那把正好是風險較高的（沒有來源限制機制）。
 */

import { settings } from '../state/settings.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
    this.detail = detail;
  }
}

/** Gemini 沒填就沿用 Vision 那把，這是共用金鑰的常見情況。 */
export function keyOf() {
  return settings.geminiKey || settings.googleKey || '';
}

async function call(path, body, { signal, retries = 2 } = {}) {
  const key = keyOf();
  if (!key) throw new GeminiError('尚未設定 Google API 金鑰', 0);

  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`${BASE}${path}?key=${encodeURIComponent(key)}`, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new GeminiError('連不上 Gemini，請檢查網路', 0, e.message);
    }

    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;

    const msg = data?.error?.message || `HTTP ${res.status}`;
    const retriable = res.status === 429 || res.status >= 500;
    if (retriable && attempt < retries) {
      await sleep((2 ** attempt) * 1500 + Math.random() * 500, signal);
      continue;
    }
    throw new GeminiError(explain(res.status, msg), res.status, msg);
  }
}

function explain(status, msg) {
  if (/API_KEY_INVALID|API key not valid/i.test(msg)) return '金鑰格式不正確或已失效';
  if (/SERVICE_DISABLED|has not been used/i.test(msg)) {
    return '這個專案還沒啟用 Generative Language API，請到 Google Cloud Console 啟用';
  }
  if (/referer|referrer/i.test(msg)) {
    return '金鑰的 HTTP referrer 限制擋掉了這個網域，請把本站網址加進允許清單';
  }
  if (status === 403 && /API_KEY_SERVICE_BLOCKED|restricted/i.test(msg)) {
    return '這把金鑰的 API 限制沒有包含 Generative Language API，請到憑證頁面加上';
  }
  if (status === 429) return '達到速率限制或免費額度上限，請稍後再試';
  if (status === 400 && /quota/i.test(msg)) return '額度不足';
  return msg;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });
}

/**
 * 產生內容，強制回傳符合 schema 的 JSON。
 * @param {{model?: string, system?: string, user: string, schema?: object,
 *          maxOutputTokens?: number, temperature?: number}} req
 */
export async function generate(req, opts = {}) {
  const model = req.model || settings.geminiModel;

  const body = {
    contents: [{ role: 'user', parts: [{ text: req.user }] }],
    generationConfig: {
      maxOutputTokens: req.maxOutputTokens ?? 8192,
      temperature: req.temperature ?? 0.3,
    },
  };
  if (req.system) body.system_instruction = { parts: [{ text: req.system }] };
  if (req.schema) {
    body.generationConfig.responseMimeType = 'application/json';
    body.generationConfig.responseSchema = req.schema;
  }

  const data = await call(`/models/${encodeURIComponent(model)}:generateContent`, body, opts);

  const cand = data.candidates?.[0];
  if (!cand) {
    // 內容被安全機制擋掉時沒有 candidate，錯誤訊息要說清楚免得使用者以為是網路問題
    const blocked = data.promptFeedback?.blockReason;
    throw new GeminiError(
      blocked ? `內容被安全機制擋下（${blocked}）` : '模型沒有回傳結果',
      200, data.promptFeedback);
  }
  if (cand.finishReason === 'MAX_TOKENS') {
    throw new GeminiError('輸出被截斷，這一頁的文字量太大', 200, cand.finishReason);
  }

  const text = (cand.content?.parts || []).map(p => p.text || '').join('');
  return { text, usage: data.usageMetadata, raw: data };
}

/** 解析結構化輸出。即使指定了 schema，偶爾仍會包在 ```json 圍欄裡。 */
export function parseJson(text) {
  const cleaned = String(text).trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '');
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new GeminiError('模型回傳的不是合法 JSON：' + e.message, 200, cleaned.slice(0, 200));
  }
}

/**
 * 列出這把金鑰實際可用的模型。
 * 硬寫模型清單很快就會過時，直接問 API 比較可靠。
 */
export async function listModels() {
  const data = await call('/models', null, { retries: 0 });
  return (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => ({
      id: m.name.replace(/^models\//, ''),
      label: m.displayName || m.name,
      inputLimit: m.inputTokenLimit,
      outputLimit: m.outputTokenLimit,
    }))
    // 沒有版本號的別名（gemini-flash-latest 之類）排前面，比較好選
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** 驗證金鑰。用 listModels 就好，不必產生任何內容，等於免費。 */
export async function ping() {
  const models = await listModels();
  if (!models.length) throw new GeminiError('金鑰可用，但沒有任何支援產生內容的模型', 200);
  return models;
}

/* 每百萬 token 的美金單價。定價會變，這裡只求量級正確，用於事前估算。 */
const PRICE = {
  'gemini-2.5-pro':   { in: 1.25, out: 10 },
  'gemini-2.5-flash': { in: 0.30, out: 2.5 },
};

export function priceOf(model) {
  if (PRICE[model]) return PRICE[model];
  // 未知模型：用名稱裡的 pro / flash 猜一個量級，總比回傳 0 讓使用者以為免費好
  if (/pro/i.test(model)) return PRICE['gemini-2.5-pro'];
  return PRICE['gemini-2.5-flash'];
}
