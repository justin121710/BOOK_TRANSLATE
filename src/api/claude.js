/* Anthropic Claude。瀏覽器直連需要 anthropic-dangerous-direct-browser-access header，
   否則會被 CORS 擋下來。
   M1 只放連線與金鑰驗證，翻譯與版面分類的 prompt 在 M4 補上。 */

import { settings } from '../state/settings.js';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';

export class ClaudeError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = 'ClaudeError';
    this.status = status;
    this.detail = detail;
  }
}

/**
 * 送一次 messages 請求。
 * @param {object} body model / max_tokens / messages / system 等
 * @param {{signal?: AbortSignal, retries?: number}} opts
 */
export async function messages(body, { signal, retries = 2 } = {}) {
  const key = settings.claudeKey;
  if (!key) throw new ClaudeError('尚未設定 Anthropic 金鑰', 0);

  const payload = { model: settings.model, ...body };

  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': VERSION,
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new ClaudeError('連不上 Anthropic，請檢查網路', 0, e.message);
    }

    if (res.ok) return res.json();

    const detail = await res.json().catch(() => ({}));
    const msg = detail?.error?.message || `HTTP ${res.status}`;

    // 過載與速率限制值得重試，其餘直接放棄
    const retriable = res.status === 429 || res.status === 529 || res.status >= 500;
    if (retriable && attempt < retries) {
      const wait = Number(res.headers.get('retry-after')) * 1000 ||
                   (2 ** attempt) * 1500 + Math.random() * 500;
      await sleep(wait, signal);
      continue;
    }
    throw new ClaudeError(explainClaude(res.status, msg), res.status, msg);
  }
}

function explainClaude(status, msg) {
  if (status === 401) return '金鑰無效或已被撤銷';
  if (status === 403) return '這把金鑰沒有存取權限';
  if (status === 400 && /credit|balance/i.test(msg)) return '帳戶額度不足，請到 Anthropic Console 儲值';
  if (status === 429) return '達到速率限制，請稍後再試';
  if (status === 529) return 'Anthropic 目前過載，請稍後再試';
  return msg;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });
}

/** 把回應裡的文字內容串起來，忽略 thinking 之類的其他 block。 */
export function textOf(response) {
  return (response?.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
}

/** 驗證金鑰。用 max_tokens 1 打一次，成本可以忽略。 */
export async function ping() {
  const r = await messages({
    max_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }],
  }, { retries: 0 });
  return Boolean(r?.id);
}
