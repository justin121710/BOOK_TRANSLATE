/* 全書專有名詞對照表的檢視與編輯。
 *
 * 詞彙表原本是自動累積、跨頁強制一致的，但完全看不到也改不了 ——
 * 人名在第 3 頁譯錯，後面 297 頁會忠實地一路錯下去，而且要等匯出才發現。
 * 以「整本書的品質」來說這是最大的單一槓桿。
 *
 * 改完譯法之後還要能把用到那個詞的頁面標回未翻譯，否則舊譯文仍留在那裡。
 */

import { setTitle, go } from '../ui/router.js';
import { askText, askConfirm } from '../ui/dialog.js';
import { icon } from '../ui/icons.js';
import { toast, ok, bad, pending } from '../ui/toast.js';
import * as db from '../state/db.js';
import * as glossary from '../translate/glossary.js';

export default async function glossaryView(root, { id }) {
  const project = id && await db.get('projects', id);
  if (!project) {
    setTitle('找不到這本書');
    root.innerHTML = `<section class="view pad"><h2>找不到這本書</h2>
      <button class="btn" data-go="home">回到書櫃</button></section>`;
    return;
  }

  setTitle('詞彙表');

  const sec = document.createElement('section');
  sec.className = 'view pad';

  const head = document.createElement('div');
  head.className = 'row-between';
  const h = document.createElement('h2');
  h.textContent = '詞彙表';
  const addBtn = document.createElement('button');
  addBtn.className = 'btn';
  addBtn.textContent = '新增';
  addBtn.addEventListener('click', addTerm);
  head.append(h, addBtn);

  const note = document.createElement('p');
  note.className = 'hint';
  note.textContent =
    '翻譯時會把整份詞彙表帶進每一頁的指令，確保同一個名字全書譯法一致。' +
    '改了譯法之後，用到那個詞的頁面要重新翻譯才會跟著更新。';

  const search = document.createElement('input');
  search.type = 'text';
  search.placeholder = '搜尋日文或中文…';
  search.style.marginTop = '12px';
  search.addEventListener('input', paint);

  const list = document.createElement('ul');
  list.className = 'card-list compact';
  list.style.marginTop = '12px';

  const empty = document.createElement('p');
  empty.className = 'hint';
  empty.textContent = '還沒有任何專有名詞。翻譯過幾頁之後這裡就會自動累積。';

  sec.append(head, note, search, empty, list);
  root.append(sec);

  await paint();

  return { back: () => go('project', { id: project.id }) };

  async function paint() {
    const terms = await glossary.load(project.id);
    const q = search.value.trim().toLowerCase();
    const shown = q
      ? terms.filter(t => t.ja.toLowerCase().includes(q) || t.zh.toLowerCase().includes(q))
      : terms;

    empty.hidden = terms.length > 0;
    search.hidden = terms.length === 0;

    list.replaceChildren(...shown.map(t => row(t)));
  }

  function row(t) {
    const li = document.createElement('li');

    const main = document.createElement('div');
    main.className = 'card-main';

    const title = document.createElement('div');
    title.className = 'card-title gloss-pair';
    const ja = document.createElement('span');
    ja.className = 'gloss-ja';
    ja.textContent = t.ja;
    const arrow = document.createElement('span');
    arrow.className = 'gloss-arrow';
    arrow.textContent = '→';
    const zh = document.createElement('span');
    zh.textContent = t.zh;
    title.append(ja, arrow, zh);

    const sub = document.createElement('div');
    sub.className = 'card-sub';
    sub.textContent = [t.note, `出現 ${t.count || 1} 次`].filter(Boolean).join('　·　');

    main.append(title, sub);

    const edit = document.createElement('button');
    edit.className = 'icon-btn';
    edit.append(icon('type', { size: 17 }));
    edit.setAttribute('aria-label', `編輯 ${t.ja} 的譯法`);
    edit.addEventListener('click', () => editTerm(t));

    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.append(icon('trash', { size: 17 }));
    del.setAttribute('aria-label', `刪除 ${t.ja}`);
    del.addEventListener('click', () => removeTerm(t));

    li.append(main, edit, del);
    return li;
  }

  async function editTerm(t) {
    const zh = await askText(`「${t.ja}」的譯法`, {
      value: t.zh,
      okLabel: '儲存',
      hint: '改完之後可以選擇要不要把用到這個詞的頁面標回未翻譯，重跑一次才會更新。',
    });
    if (zh === null || !zh.trim() || zh.trim() === t.zh) return;

    await glossary.update(t.id, { zh: zh.trim() });
    await paint();
    await offerRetranslate(t.ja, zh.trim());
  }

  async function addTerm() {
    const ja = await askText('新增專有名詞', {
      placeholder: '日文原文', okLabel: '下一步',
      hint: '例如人名、地名、作品名、術語。',
    });
    if (ja === null || !ja.trim()) return;

    const zh = await askText(`「${ja.trim()}」的譯法`, { okLabel: '新增' });
    if (zh === null || !zh.trim()) return;

    await glossary.merge(project.id, [{ ja: ja.trim(), zh: zh.trim(), note: '手動新增' }]);
    ok('已新增');
    await paint();
    await offerRetranslate(ja.trim(), zh.trim());
  }

  async function removeTerm(t) {
    const yes = await askConfirm(`刪除「${t.ja} → ${t.zh}」？`, {
      detail: '之後翻譯時就不再強制這個譯法，已經翻好的頁面不受影響。',
      okLabel: '刪除', danger: true,
    });
    if (!yes) return;
    await glossary.remove(t.id);
    toast('已刪除');
    await paint();
  }

  /**
   * 改了譯法之後，把含有這個詞的頁面標回未翻譯。
   * 只清掉那些區塊的譯文並把頁面狀態退回 'ocr'，
   * 下次按翻譯時就只會重跑這些頁，不會整本重來。
   */
  async function offerRetranslate(ja, zh) {
    const blocks = await db.getBy('blocks', 'projectId', project.id);
    const hits = blocks.filter(b =>
      b.dstText != null && !b.skipTranslate && String(b.srcText || '').includes(ja));

    if (!hits.length) {
      toast('已更新。目前沒有已翻譯的頁面用到這個詞');
      return;
    }

    const pageIds = new Set(hits.map(b => b.pageId));
    const yes = await askConfirm(`要重新翻譯 ${pageIds.size} 頁嗎？`, {
      detail:
        `有 ${hits.length} 個區塊的原文含有「${ja}」，它們目前的譯文是用舊譯法翻的。\n\n` +
        `按下確定會把這些區塊的譯文清掉、頁面標回未翻譯，` +
        `下次執行翻譯時只會重跑這幾頁，不會整本重來。`,
      okLabel: `標記 ${pageIds.size} 頁重翻`,
    });
    if (!yes) return;

    const p = pending('標記中…');
    try {
      await db.putMany('blocks', hits.map(b => ({ ...b, dstText: null, error: null })));

      const pages = await db.getBy('pages', 'projectId', project.id);
      const updates = pages
        .filter(pg => pageIds.has(pg.id))
        .map(pg => ({ ...pg, status: 'ocr', error: null }));
      if (updates.length) await db.putMany('pages', updates);

      await db.touchProject(project.id);
      p.done(`已標記 ${updates.length} 頁待重翻`, 'ok');
    } catch (e) {
      p.done();
      bad('標記失敗：' + e.message);
    }
  }
}
