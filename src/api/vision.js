/* Google Cloud Vision。M1 只放連線與金鑰驗證，
   實際的 DOCUMENT_TEXT_DETECTION 解析在 M3 補上。 */

import { settings } from '../state/settings.js';

const ENDPOINT = 'https://vision.googleapis.com/v1/images:annotate';

// 1×1 透明 PNG，只為了驗證金鑰能不能過
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export class VisionError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = 'VisionError';
    this.status = status;
    this.detail = detail;
  }
}

export async function annotate(requests) {
  const key = settings.googleKey;
  if (!key) throw new VisionError('尚未設定 Google Cloud Vision 金鑰', 0);

  let res;
  try {
    res = await fetch(`${ENDPOINT}?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requests }),
    });
  } catch (e) {
    throw new VisionError('連不上 Google Cloud Vision，請檢查網路', 0, e.message);
  }

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = body?.error?.message || `HTTP ${res.status}`;
    throw new VisionError(explainVision(res.status, msg), res.status, msg);
  }

  // 批次請求裡個別項目也可能失敗，這裡不吞掉
  const first = body.responses?.[0];
  if (first?.error) {
    throw new VisionError(first.error.message || '辨識失敗', 200, first.error);
  }
  return body.responses || [];
}

function explainVision(status, msg) {
  if (status === 400 && /API key not valid/i.test(msg)) return '金鑰格式不正確或已失效';
  if (status === 403 && /referer|referrer/i.test(msg)) {
    return '金鑰的 HTTP referrer 限制擋掉了這個網域，請到 Google Cloud Console 把本站網址加進允許清單';
  }
  if (status === 403 && /API has not been used|disabled/i.test(msg)) {
    return '這個專案還沒啟用 Cloud Vision API，請到 Google Cloud Console 啟用';
  }
  if (status === 403) return '金鑰沒有權限：' + msg;
  if (status === 429) return '超過配額或速率限制，請稍後再試';
  return msg;
}

/** 驗證金鑰。會實際打一次 API（1 個單位，約 US$0.0015）。 */
export async function ping() {
  await annotate([{
    image: { content: PIXEL },
    features: [{ type: 'TEXT_DETECTION', maxResults: 1 }],
  }]);
  return true;
}
