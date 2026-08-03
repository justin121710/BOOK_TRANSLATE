import { setTitle, go } from '../ui/router.js';
import { askConfirm, askText } from '../ui/dialog.js';
import { toast, ok, bad, pending } from '../ui/toast.js';
import * as db from '../state/db.js';
import { listPages, applyCorners, deletePage, renumber } from '../input/pages.js';
import { blobToBitmap } from '../preprocess/enhance.js';
import { cropper } from '../ui/cropper.js';

const KIND_LABEL = {
  title: '標題', body: '正文', caption: '圖說', note: '註解', quote: '引文',
  table: '表格', header: '頁眉', footer: '頁尾', pagenum: '頁碼',
};

export default async function pageView(root, { id }) {
  const page = id && await db.get('pages', id);
  if (!page) {
    setTitle('找不到這一頁');
    root.innerHTML = `<section class="view pad"><h2>找不到這一頁</h2>
      <button class="btn" data-go="home">回到書櫃</button></section>`;
    return;
  }

  const siblings = await listPages(page.projectId);
  const pos = siblings.findIndex(p => p.id === page.id);
  setTitle(`第 ${page.index + 1} / ${siblings.length} 頁`);

  const sec = document.createElement('section');
  sec.className = 'view page-view';
  root.append(sec);

  const stage = document.createElement('div');
  stage.className = 'page-stage';

  const bar = document.createElement('div');
  bar.className = 'page-bar';

  sec.append(stage, bar);

  let editor = null;
  let objectUrl = null;
  let current = page;
  let showBlocks = true;

  await showPreview();

  return {
    teardown() {
      editor?.destroy();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    },
  };

  /* ---------- 檢視模式 ---------- */

  async function showPreview() {
    editor?.destroy();
    editor = null;
    stage.replaceChildren();
    bar.replaceChildren();

    const blocks = (await db.getBy('blocks', 'pageId', current.id))
      .sort((a, b) => a.order - b.order);

    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(current.procBlob || current.origBlob);

    if (blocks.length && showBlocks) {
      // 疊上辨識結果：框、閱讀順序編號、直排與橫排用不同顏色
      const { renderOverlay } = await import('../ocr/index.js');
      const canvas = await renderOverlay(current, blocks, { scale: 1 });
      canvas.className = 'page-full';
      stage.append(canvas);
    } else {
      const img = document.createElement('img');
      img.className = 'page-full';
      img.src = objectUrl;
      img.alt = `第 ${current.index + 1} 頁`;
      stage.append(img);
    }

    const info = document.createElement('p');
    info.className = 'hint page-info';
    info.textContent = describe(current, blocks);
    stage.append(info);

    if (blocks.length) {
      const toggle = document.createElement('button');
      toggle.className = 'link';
      toggle.textContent = showBlocks ? '隱藏辨識框' : '顯示辨識框';
      toggle.addEventListener('click', () => { showBlocks = !showBlocks; showPreview(); });
      stage.append(toggle);

      const list = document.createElement('ol');
      list.className = 'block-list';
      for (const b of blocks) list.append(blockRow(b));
      stage.append(list);
    }

    bar.append(
      navBtn('‹ 上一頁', pos > 0, () => go('page', { id: siblings[pos - 1].id })),
      btn(current.corners ? '重新校正' : '透視校正', 'btn-primary', showEditor),
      navBtn('下一頁 ›', pos < siblings.length - 1, () => go('page', { id: siblings[pos + 1].id })),
    );

    const more = document.createElement('div');
    more.className = 'page-bar-secondary';
    more.append(btn('圖片框', '', showFigures));
    if (blocks.some(b => b.dstText)) {
      more.append(btn('排版預覽', '', showLayoutPreview));
    }
    more.append(btn('刪除這一頁', 'btn-danger', removeSelf));
    bar.append(more);
  }

  /* ---------- 圖片框編輯 ---------- */

  async function showFigures() {
    stage.replaceChildren();
    bar.replaceChildren();

    const p = pending('載入…');
    let bitmap, figures, blocks;
    try {
      const { processedBlob } = await import('../input/pages.js');
      bitmap = await blobToBitmap(await processedBlob(current));
      figures = await db.getBy('figures', 'pageId', current.id);
      blocks = await db.getBy('blocks', 'pageId', current.id);
    } catch (e) {
      p.done(); bad(e.message); return showPreview();
    }
    p.done();

    const { boxEditor } = await import('../ui/boxeditor.js');
    editor = boxEditor(bitmap, figures, {});
    stage.append(editor.el);

    const tip = document.createElement('p');
    tip.className = 'hint page-info';
    tip.textContent =
      '在空白處拖曳可新增圖片框，點框選取後可拖角落調整。' +
      '自動偵測一定會有誤判，這裡的人工確認不能省。';
    stage.append(tip);

    bar.append(
      btn('取消', '', () => { bitmap.close?.(); showPreview(); }),
      btn('自動偵測', '', async (e) => {
        e.target.disabled = true;
        const q = pending('偵測中…');
        try {
          const { detectFigures } = await import('../pdf/figures.js');
          const found = detectFigures(bitmap, blocks);
          editor.set(found);
          q.done(found.length ? `找到 ${found.length} 個候選` : '沒有找到候選區', found.length ? 'ok' : '');
        } catch (err) {
          q.done(); bad(err.message);
        }
        e.target.disabled = false;
      }),
      btn('刪除選取', '', () => {
        if (!editor.removeSelected()) toast('請先點一個框');
      }),
      btn('儲存', 'btn-primary', async (e) => {
        e.target.disabled = true;
        try {
          await db.delBy('figures', 'pageId', current.id);
          const rows = editor.rects().map(r => ({
            id: db.uid('fg_'), pageId: current.id, projectId: current.projectId, ...r,
          }));
          if (rows.length) await db.putMany('figures', rows);
          ok(`已儲存 ${rows.length} 個圖片框`);
          bitmap.close?.();
          showPreview();
        } catch (err) {
          bad('儲存失敗：' + err.message);
          e.target.disabled = false;
        }
      }),
    );
  }

  /* ---------- 排版預覽（原頁與重排結果並排） ---------- */

  async function showLayoutPreview() {
    stage.replaceChildren();
    bar.replaceChildren();

    const p = pending('排版中…');
    try {
      const blocks = (await db.getBy('blocks', 'pageId', current.id))
        .sort((a, b) => a.order - b.order);
      const { renderPage } = await import('../render/canvas.js');
      const { processedBlob } = await import('../input/pages.js');

      const W = current.procW || current.origW;
      const H = current.procH || current.origH;
      const scale = Math.min(1, 900 / Math.max(W, H));

      const { canvas, report } = renderPage({ width: W, height: H }, blocks,
        { scale, showBoxes: true });

      const wrap = document.createElement('div');
      wrap.className = 'compare';

      const left = document.createElement('figure');
      left.className = 'compare-cell';
      const lc = document.createElement('figcaption');
      lc.textContent = '原頁';
      const img = document.createElement('img');
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(await processedBlob(current));
      img.src = objectUrl;
      left.append(lc, img);

      const right = document.createElement('figure');
      right.className = 'compare-cell';
      const rc = document.createElement('figcaption');
      rc.textContent = '重排結果';
      right.append(rc, canvas);

      wrap.append(left, right);
      stage.append(wrap);

      const bad_ = report.filter(r => r.overflow);
      const shrunk = report.filter(r => r.scale < 0.999);
      const info = document.createElement('p');
      info.className = 'hint page-info';
      info.textContent = [
        `${report.length} 個文字塊`,
        shrunk.length ? `${shrunk.length} 塊縮過字級（最小 ${Math.min(...shrunk.map(r => r.scale)).toFixed(2)}×）` : '沒有縮字',
        bad_.length ? `${bad_.length} 塊仍然放不下（紅框）` : '沒有溢出',
      ].join('　·　');
      stage.append(info);
      p.done();
    } catch (e) {
      p.done();
      bad('排版失敗：' + e.message);
      return showPreview();
    }

    bar.append(
      btn('返回', '', showPreview),
      btn('圖片框', '', showFigures),
      btn('回到書籍', '', () => go('project', { id: current.projectId })),
    );
  }

  /* ---------- 校正模式 ---------- */

  async function showEditor() {
    stage.replaceChildren();
    bar.replaceChildren();

    const p = pending('載入影像…');
    let bitmap;
    try {
      bitmap = await blobToBitmap(current.origBlob);
    } catch (e) {
      p.done();
      bad(e.message);
      return showPreview();
    }
    p.done();

    editor = cropper(bitmap, current.corners);
    stage.append(editor.el);

    const tip = document.createElement('p');
    tip.className = 'hint page-info';
    tip.textContent = '拖動四個角對準書頁邊界。拖動時右上或左下會出現放大鏡幫你對準。';
    stage.append(tip);

    bar.append(
      btn('取消', '', () => { bitmap.close?.(); showPreview(); }),
      btn('整頁不裁切', '', () => editor.reset()),
      btn('套用', 'btn-primary', async (e) => {
        e.target.disabled = true;
        const q = pending('校正中…');
        try {
          current = await applyCorners(current, editor.corners());
          await db.touchProject(current.projectId);
          q.done('已套用', 'ok');
          bitmap.close?.();
          showPreview();
        } catch (err) {
          q.done();
          bad('校正失敗：' + err.message);
          e.target.disabled = false;
        }
      }),
    );
  }

  /* ---------- 區塊列 ---------- */

  function blockRow(b) {
    const li = document.createElement('li');
    li.className = 'block-item' + (b.vertical ? ' vertical' : '');

    const tags = document.createElement('span');
    tags.className = 'block-tags';
    tags.append(pill(KIND_LABEL[b.kind] || b.kind, b.kind));
    if (b.vertical) tags.append(pill('直排', 'vertical'));

    const body = document.createElement('div');
    body.className = 'block-body';

    const src = document.createElement('p');
    src.className = 'block-src';
    src.textContent = b.srcText.replace(/\n/g, '⏎');
    body.append(src);

    if (b.skipTranslate) {
      const note = document.createElement('p');
      note.className = 'block-note';
      note.textContent = '不翻譯，匯出時從原圖裁切貼回';
      body.append(note);
    } else if (b.dstText) {
      const dst = document.createElement('p');
      dst.className = 'block-dst';
      dst.textContent = b.dstText.replace(/\n/g, '⏎');
      body.append(dst);
    } else if (b.error) {
      const err = document.createElement('p');
      err.className = 'block-note bad';
      err.textContent = b.error;
      body.append(err);
    }

    if (b.dstText != null || b.error) {
      const again = document.createElement('button');
      again.className = 'link block-retry';
      again.textContent = '重跑這一塊';
      again.addEventListener('click', () => retryBlock(b));
      body.append(again);
    }

    li.append(tags, body);
    return li;
  }

  function pill(text, kind) {
    const s = document.createElement('span');
    s.className = 'pill' + (kind === 'vertical' ? ' vert' : '');
    s.textContent = text;
    return s;
  }

  /**
   * 單塊重跑。對話框一定要顯示 OCR 讀到的原始日文 ——
   * 使用者得看得出來是翻錯了，還是 OCR 根本就讀錯。
   */
  async function retryBlock(b) {
    const instruction = await askText('重跑這一塊', {
      value: '',
      placeholder: '例如：這是人名／這裡是直排／語氣再口語一點',
      okLabel: '重跑',
      hint: `OCR 讀到的原文：\n${b.srcText}\n\n目前譯文：${b.dstText || '（無）'}`,
    });
    if (instruction === null) return;

    const p = pending('重跑中…');
    try {
      const { retranslateBlock } = await import('../translate/index.js');
      const r = await retranslateBlock(b, { instruction: instruction.trim() });
      p.done(`已更新　US$${r.cost.toFixed(4)}`, 'ok');
      showPreview();
    } catch (e) {
      p.done();
      bad('重跑失敗：' + e.message);
    }
  }

  /* ---------- 動作 ---------- */

  async function removeSelf() {
    const yes = await askConfirm(`刪除第 ${current.index + 1} 頁？`, {
      detail: '這一頁的影像與已產生的譯文都會消失，無法復原。',
      okLabel: '刪除', danger: true,
    });
    if (!yes) return;

    const projectId = current.projectId;
    await deletePage(current.id);
    await renumber(projectId);
    ok('已刪除');
    go('project', { id: projectId });
  }

  function btn(label, cls, onClick) {
    const b = document.createElement('button');
    b.className = 'btn ' + cls;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  function navBtn(label, enabled, onClick) {
    const b = btn(label, '', onClick);
    b.disabled = !enabled;
    return b;
  }
}

function describe(page, blocks = []) {
  const src = { camera: '相機', photo: '相簿', pdf: 'PDF', epub: 'EPUB' }[page.source] || page.source;
  const bits = [`來源 ${src}`, `${page.procW || page.origW}×${page.procH || page.origH}`];
  if (page.nativeText) bits.push(`原生文字層 ${page.nativeText.length} 段（不需 OCR）`);
  if (!page.corners) bits.push('尚未透視校正');
  if (blocks.length) {
    bits.push(`${blocks.length} 個文字塊`);
    bits.push(page.vertical ? '直排' : '橫排');
    if (page.rubyDropped) bits.push(`丟棄振り仮名 ${page.rubyDropped} 處`);
  }
  return bits.join('　·　');
}
