/* 整本書的原文／譯文對照檢視。
 *
 * 沒有這個的話，複查 300 頁要一頁一頁點進去 —— 複查成本隨頁數線性上升，
 * 到某個厚度就等於沒有複查。
 *
 * 這裡只做「找得到、看得到、跳得過去」，實際修改仍在單頁檢視裡做：
 * 修改需要看到版面才判斷得準。
 */

import { setTitle, go } from '../ui/router.js';
import { icon } from '../ui/icons.js';
import * as db from '../state/db.js';
import { inlineMath } from '../ocr/mathspan.js';

const KIND_LABEL = {
  title: '標題', body: '正文', caption: '圖說', note: '註解', quote: '引文',
  table: '表格', figuretext: '圖內文字', equation: '方程式',
  header: '頁眉', footer: '頁尾', pagenum: '頁碼',
};

export default async function reviewView(root, { id }) {
  const project = id && await db.get('projects', id);
  if (!project) {
    setTitle('找不到這本書');
    root.innerHTML = `<section class="view pad"><h2>找不到這本書</h2>
      <button class="btn" data-go="home">回到書櫃</button></section>`;
    return;
  }

  setTitle('整本檢視');

  const sec = document.createElement('section');
  sec.className = 'view pad';

  const search = document.createElement('input');
  search.type = 'text';
  search.placeholder = '搜尋原文或譯文…';

  const filterBar = document.createElement('div');
  filterBar.className = 'filter-bar';
  let filter = 'all';
  for (const [key, label] of [
    ['all', '全部'],
    ['untranslated', '未翻譯'],
    ['overflow', '有溢出'],
    ['fixed', 'AI 判讀修正'],
    ['math', '含公式'],
  ]) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.filter = key;
    b.textContent = label;
    b.addEventListener('click', () => { filter = key; paint(); });
    filterBar.append(b);
  }

  const summary = document.createElement('p');
  summary.className = 'hint';

  const body = document.createElement('div');
  body.className = 'review';

  sec.append(search, filterBar, summary, body);
  root.append(sec);

  const pages = (await db.getBy('pages', 'projectId', project.id))
    .sort((a, b) => a.index - b.index);
  const byPage = new Map();
  for (const p of pages) {
    byPage.set(p.id, (await db.getBy('blocks', 'pageId', p.id))
      .sort((a, b) => a.order - b.order));
  }

  search.addEventListener('input', paint);
  paint();

  return { back: () => go('project', { id: project.id }) };

  function matches(b) {
    if (filter === 'untranslated') return !b.skipTranslate && b.dstText == null;
    if (filter === 'overflow') return Boolean(b.overflow);
    if (filter === 'fixed') return Boolean(b.srcFixed);
    if (filter === 'math') return Boolean(b.mathSpans?.length);
    return true;
  }

  function paint() {
    const q = search.value.trim().toLowerCase();
    for (const b of filterBar.children) {
      b.classList.toggle('on', b.dataset.filter === filter);
    }

    body.replaceChildren();
    let shownBlocks = 0, shownPages = 0;

    for (const page of pages) {
      const blocks = (byPage.get(page.id) || []).filter(b => {
        if (!matches(b)) return false;
        if (!q) return true;
        const src = inlineMath(b.srcText, b.mathSpans).toLowerCase();
        const dst = inlineMath(b.dstText || '', b.mathSpans).toLowerCase();
        return src.includes(q) || dst.includes(q);
      });
      if (!blocks.length) continue;

      shownPages++;
      shownBlocks += blocks.length;
      body.append(pageSection(page, blocks, q));
    }

    summary.textContent = shownPages
      ? `${shownPages} 頁　·　${shownBlocks} 個區塊`
      : '沒有符合的內容';
  }

  function pageSection(page, blocks, q) {
    const wrap = document.createElement('section');
    wrap.className = 'review-page';

    const head = document.createElement('button');
    head.className = 'review-head';
    head.addEventListener('click', () => go('page', { id: page.id }));
    const label = document.createElement('span');
    label.textContent = `第 ${page.index + 1} 頁`;
    const jump = document.createElement('span');
    jump.className = 'review-jump';
    jump.textContent = '開啟';
    jump.append(icon('back', { size: 14, className: 'flip' }));
    head.append(label, jump);
    wrap.append(head);

    for (const b of blocks) wrap.append(blockRow(b, q));
    return wrap;
  }

  function blockRow(b, q) {
    const row = document.createElement('div');
    row.className = 'review-row';

    const tag = document.createElement('span');
    tag.className = 'pill';
    tag.textContent = KIND_LABEL[b.kind] || b.kind;

    const texts = document.createElement('div');
    texts.className = 'review-texts';

    const src = document.createElement('p');
    src.className = 'review-src';
    fillHighlighted(src, inlineMath(b.srcText, b.mathSpans), q);
    texts.append(src);

    if (b.skipTranslate) {
      texts.append(note('不翻譯，匯出時從原圖裁切貼回'));
    } else if (b.dstText) {
      const dst = document.createElement('p');
      dst.className = 'review-dst';
      fillHighlighted(dst, inlineMath(b.dstText, b.mathSpans), q);
      texts.append(dst);
    } else {
      texts.append(note('尚未翻譯', 'bad'));
    }

    const flags = [];
    if (b.overflow) flags.push('放不下');
    if (b.srcFixed) flags.push('AI 判讀修正');
    if (b.mathSpans?.length) flags.push(`${b.mathSpans.length} 個公式`);
    if (flags.length) texts.append(note(flags.join('　·　')));

    row.append(tag, texts);
    return row;
  }

  function note(text, cls = '') {
    const p = document.createElement('p');
    p.className = 'block-note ' + cls;
    p.textContent = text;
    return p;
  }

  /** 把搜尋詞標起來。用 textContent 逐段塞，不碰 innerHTML。 */
  function fillHighlighted(el, text, q) {
    const s = String(text || '').replace(/\n/g, '⏎');
    if (!q) { el.textContent = s; return; }

    const lower = s.toLowerCase();
    let at = 0;
    for (;;) {
      const i = lower.indexOf(q, at);
      if (i < 0) break;
      if (i > at) el.append(document.createTextNode(s.slice(at, i)));
      const mark = document.createElement('mark');
      mark.textContent = s.slice(i, i + q.length);
      el.append(mark);
      at = i + q.length;
    }
    if (at < s.length) el.append(document.createTextNode(s.slice(at)));
  }
}
