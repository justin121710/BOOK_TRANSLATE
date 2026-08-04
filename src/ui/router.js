/* 極簡 hash 路由。用 hash 是因為 GitHub Pages 沒有 SPA rewrite，
   history API 一重新整理就 404。 */

import { icon } from './icons.js';

const routes = new Map();
let current = null;

export function route(name, handler) {
  routes.set(name, handler);
}

export function go(name, params = {}) {
  const q = new URLSearchParams(params).toString();
  location.hash = '#' + name + (q ? '?' + q : '');
}

/**
 * 返回。
 *
 * 預設走瀏覽器歷史，但視圖可以在回傳物件上放一個 back 函式來覆寫。
 * 逐頁瀏覽時歷史裡塞的全是單頁畫面，一路按回去要按很多次才回得到書籍頁，
 * 所以那種情況由視圖自己指定要回哪裡。
 */
export function back() {
  if (typeof current?.back === 'function') {
    current.back();
    return;
  }
  if (history.length > 1) history.back();
  else go('home');
}

function parse() {
  const raw = location.hash.replace(/^#/, '') || 'home';
  const [name, query = ''] = raw.split('?');
  return { name, params: Object.fromEntries(new URLSearchParams(query)) };
}

async function render() {
  const { name, params } = parse();
  const handler = routes.get(name) || routes.get('home');
  const view = document.getElementById('view');

  // 上一個視圖可能掛了計時器或事件監聽，給它機會收乾淨
  if (current?.teardown) {
    try { current.teardown(); } catch (e) { console.warn('teardown 失敗', e); }
  }

  view.replaceChildren();
  current = (await handler(view, params)) || null;

  document.getElementById('navBack').hidden = (name === 'home');
  window.scrollTo(0, 0);
}

export function start() {
  addEventListener('hashchange', render);

  const backBtn = document.getElementById('navBack');
  const settingsBtn = document.getElementById('navSettings');
  backBtn.append(icon('back', { size: 24 }));
  settingsBtn.append(icon('settings', { size: 21 }));

  backBtn.addEventListener('click', back);
  settingsBtn.addEventListener('click', () => go('settings'));

  // 任何地方寫 data-go="xxx" 就能導頁，不用各自綁事件
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-go]');
    if (t) { e.preventDefault(); go(t.dataset.go); }
  });

  return render();
}

export function setTitle(text) {
  document.getElementById('topTitle').textContent = text;
}

/** 從 <template> 取一份副本，模板放在 index.html 裡便於一眼看完結構。 */
export function tpl(id) {
  const t = document.getElementById(id);
  if (!t) throw new Error(`找不到模板 #${id}`);
  return t.content.cloneNode(true);
}
