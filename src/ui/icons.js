/* 圖標。
 *
 * 不用 emoji：同一個字碼在 iOS、Android、Windows 上長得完全不同，
 * 大小與基線也對不齊，而且沒辦法跟著主題變色。
 * 這裡全部是 24×24 的線條圖，描邊用 currentColor，所以會自動跟著文字顏色走。
 */

const NS = 'http://www.w3.org/2000/svg';

/* 內容都是本檔案裡的靜態字串，沒有任何外部輸入會流進來 */
const PATHS = {
  back: '<path d="M15 18l-6-6 6-6"/>',

  settings:
    '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/>' +
    '<path d="M1 14h6M9 8h6M17 16h6"/>',

  eye:
    '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>' +
    '<circle cx="12" cy="12" r="3"/>',

  eyeOff:
    '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>' +
    '<path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>' +
    '<path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/>' +
    '<path d="M1 1l22 22"/>',

  camera:
    '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>' +
    '<circle cx="12" cy="13" r="4"/>',

  image:
    '<rect x="3" y="3" width="18" height="18" rx="2"/>' +
    '<circle cx="8.5" cy="8.5" r="1.5"/>' +
    '<path d="M21 15l-5-5L5 21"/>',

  file:
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>' +
    '<path d="M14 2v6h6"/>',

  book:
    '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>' +
    '<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',

  scan:
    '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/>' +
    '<path d="M7 11h10M7 15h6"/>',

  translate:
    '<path d="M2 5h12M8 2v3"/>' +
    '<path d="M11 5c0 4-3.5 8-8 8"/>' +
    '<path d="M5 9c0 2.5 3 4.5 6 5.5"/>' +
    '<path d="M13 21l4.5-10L22 21"/>' +
    '<path d="M14.8 17h5.4"/>',

  trash:
    '<path d="M3 6h18"/>' +
    '<path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/>' +
    '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>' +
    '<path d="M10 11v6M14 11v6"/>',

  // 這一頁有 PDF 原生文字層，不需要 OCR
  type: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>',

  // 這一頁還沒做透視校正
  crop:
    '<path d="M6.13 1L6 16a2 2 0 0 0 2 2h15"/>' +
    '<path d="M1 6.13L16 6a2 2 0 0 1 2 2v15"/>',

  plus: '<path d="M12 5v14M5 12h14"/>',

  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',

  book2:
    '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>' +
    '<path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',

  list:
    '<path d="M8 6h13M8 12h13M8 18h13"/>' +
    '<path d="M3 6h.01M3 12h.01M3 18h.01"/>',

  download:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
    '<path d="M7 10l5 5 5-5M12 15V3"/>',
};

/**
 * 造一個 SVG 圖標元素。
 * @param {keyof PATHS} name
 * @param {{size?: number, stroke?: number, className?: string}} opts
 */
export function icon(name, { size = 20, stroke = 1.9, className = '' } = {}) {
  const body = PATHS[name];
  if (!body) throw new Error(`沒有這個圖標：${name}`);

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(stroke));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('icon');
  if (className) svg.classList.add(...className.split(' ').filter(Boolean));
  svg.innerHTML = body;
  return svg;
}

/**
 * 把圖標放進既有的按鈕，並保留可讀的無障礙名稱。
 * 按鈕原本若有文字，文字會留在圖標右邊。
 */
export function setIcon(el, name, opts) {
  const label = el.getAttribute('aria-label') || el.textContent.trim();
  el.textContent = '';
  el.prepend(icon(name, opts));
  if (label) el.setAttribute('aria-label', label);
  return el;
}

/** 圖標 + 文字的按鈕。 */
export function iconButton(name, label, { className = 'btn', onClick, size } = {}) {
  const b = document.createElement('button');
  b.className = className;
  b.append(icon(name, { size }));
  if (label) {
    const span = document.createElement('span');
    span.textContent = label;
    b.append(span);
  } else {
    b.setAttribute('aria-label', name);
  }
  if (onClick) b.addEventListener('click', onClick);
  return b;
}
