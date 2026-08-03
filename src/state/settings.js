/* 金鑰與偏好設定。只用 localStorage —— 這些值都很小，而且開 App 時要同步讀得到。
   金鑰以明文存放：這是一支自帶金鑰的本機工具，瀏覽器裡沒有任何地方能真的藏住它。
   混淆只會給人假的安全感，所以不做。設定頁會直白說明這件事。 */

const NS = 'bt.';

const DEFAULTS = {
  googleKey: '',
  claudeKey: '',
  model: 'claude-opus-5',
  bodyFont: 'serif',      // serif = 思源宋體（內文）
  titleFont: 'sans',      // sans  = 思源黑體（標題）
  dropRuby: true,         // 丟棄振り仮名
  translateHeaders: false,// 頁眉／頁碼／側標不送翻譯
  minFontScale: 0.08,     // 溢框時字級可縮到原字高的幾成
  onboarded: false,
};

function read(key) {
  try {
    const raw = localStorage.getItem(NS + key);
    if (raw === null) return DEFAULTS[key];
    return JSON.parse(raw);
  } catch {
    return DEFAULTS[key];
  }
}

function write(key, value) {
  try {
    localStorage.setItem(NS + key, JSON.stringify(value));
  } catch (e) {
    // Safari 無痕模式會直接丟 QuotaExceededError
    console.warn('無法寫入設定', key, e);
  }
}

export const settings = new Proxy({}, {
  get: (_, key) => read(key),
  set: (_, key, value) => { write(key, value); return true; },
  has: (_, key) => key in DEFAULTS,
  ownKeys: () => Reflect.ownKeys(DEFAULTS),
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
});

export function hasKeys() {
  return Boolean(read('googleKey') && read('claudeKey'));
}

export function missingKeys() {
  const out = [];
  if (!read('googleKey')) out.push('Google Cloud Vision');
  if (!read('claudeKey')) out.push('Anthropic Claude');
  return out;
}

/** 只回傳能安全顯示在畫面上的遮罩形式。 */
export function maskKey(k) {
  if (!k) return '';
  if (k.length <= 12) return '•'.repeat(k.length);
  return k.slice(0, 6) + '…' + k.slice(-4);
}

export function clearKeys() {
  write('googleKey', '');
  write('claudeKey', '');
}
