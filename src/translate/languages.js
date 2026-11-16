export const TARGET_LANGUAGES = Object.freeze({
  'zh-Hant': '繁體中文（臺灣）',
  'zh-Hans': '簡體中文',
  en: '英文',
  ja: '日文',
});

export function targetLanguage(value) {
  return Object.hasOwn(TARGET_LANGUAGES, value) ? value : 'zh-Hant';
}

export function targetLabel(value) {
  return TARGET_LANGUAGES[targetLanguage(value)];
}
