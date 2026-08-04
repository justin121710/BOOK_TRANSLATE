import { setTitle, go } from '../ui/router.js';
import { askConfirm, askText, askTextarea } from '../ui/dialog.js';
import { toast, ok, bad, pending } from '../ui/toast.js';
import * as db from '../state/db.js';
import { listPages, applyCorners, deletePage, renumber } from '../input/pages.js';
import { blobToBitmap } from '../preprocess/enhance.js';
import { cropper } from '../ui/cropper.js';
import { inlineMath } from '../ocr/mathspan.js';

const KIND_LABEL = {
  title: '標題', body: '正文', caption: '圖說', note: '註解', quote: '引文',
  table: '表格', figuretext: '圖內文字', header: '頁眉', footer: '頁尾', pagenum: '頁碼',
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

  /* 左上角的返回鍵。
     逐頁翻書時歷史裡塞的全是單頁畫面，走瀏覽器歷史要按很多次才回得到書籍頁，
     所以檢視模式一律直接回書籍頁。
     校正、圖片框、排版預覽這幾個子模式則先退回檢視模式，
     避免一鍵離開把還沒儲存的編輯默默丟掉。 */
  const toProject = () => go('project', { id: current.projectId });

  const nav = {
    back: toProject,
    teardown() {
      editor?.destroy();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    },
  };

  await showPreview();
  return nav;

  /* ---------- 檢視模式 ---------- */

  async function showPreview() {
    editor?.destroy();
    editor = null;
    nav.back = toProject;
    stage.replaceChildren();
    bar.replaceChildren();

    const blocks = (await db.getBy('blocks', 'pageId', current.id))
      .sort((a, b) => a.order - b.order);

    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;

    const pageBlob = current.procBlob || current.origBlob;
    if (!pageBlob) {
      // EPUB：沒有掃描影像，直接把重排結果畫出來當預覽
      const { renderPage } = await import('../render/canvas.js');
      const W = current.procW || current.origW;
      const H = current.procH || current.origH;
      const { canvas } = renderPage({ width: W, height: H }, blocks,
        { scale: Math.min(1, 700 / Math.max(W, H)) });
      canvas.className = 'page-full';
      stage.append(canvas);
    } else {
      objectUrl = URL.createObjectURL(pageBlob);
    }

    if (pageBlob && blocks.length && showBlocks) {
      // 疊上辨識結果：框、閱讀順序編號、直排與橫排用不同顏色
      const { renderOverlay } = await import('../ocr/index.js');
      const canvas = await renderOverlay(current, blocks, { scale: 1 });
      canvas.className = 'page-full';
      stage.append(canvas);
    } else if (pageBlob) {
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
      if (pageBlob) {
        const toggle = document.createElement('button');
        toggle.className = 'link';
        toggle.textContent = showBlocks ? '隱藏辨識框' : '顯示辨識框';
        toggle.addEventListener('click', () => { showBlocks = !showBlocks; showPreview(); });
        stage.append(toggle);
      }

      const list = document.createElement('ol');
      list.className = 'block-list';
      for (const b of blocks) list.append(blockRow(b));
      stage.append(list);
    }

    // EPUB 沒有掃描影像，透視校正與圖片框對它沒有意義
    const hasImage = Boolean(pageBlob);

    bar.append(
      navBtn('‹ 上一頁', pos > 0, () => go('page', { id: siblings[pos - 1].id })),
      hasImage
        ? btn(current.corners ? '重新校正' : '透視校正', 'btn-primary', showEditor)
        : btn('回到書籍', 'btn-primary', () => go('project', { id: current.projectId })),
      navBtn('下一頁 ›', pos < siblings.length - 1, () => go('page', { id: siblings[pos + 1].id })),
    );

    const more = document.createElement('div');
    more.className = 'page-bar-secondary';
    if (hasImage) more.append(btn('圖片框', '', showFigures));
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
    nav.back = showPreview;    // 子模式：先退回檢視，別把沒存的框丟掉

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
      '在空白處拖曳可新增框，點框選取後可拖角落調整。' +
      '插圖（藍）圖內的日文會被中譯蓋掉；方程式（紫）整塊原樣貼回，一個符號都不動。';
    stage.append(tip);

    bar.append(
      btn('取消', '', () => { bitmap.close?.(); showPreview(); }),
      btn('切換為方程式', '', () => {
        const k = editor.toggleKind();
        if (k === null) toast('請先點一個框');
        else toast(k === 'equation' ? '已設為方程式，整塊原樣貼回' : '已設為插圖');
      }),
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
          // 方程式框會讓框內文字改成不翻譯，那個標記是辨識時打的
          const eqs = rows.filter(r => r.kind === 'equation').length;
          if (rows.length) await db.putMany('figures', rows);
          ok(eqs ? `已儲存 ${rows.length} 個框（含 ${eqs} 個方程式）`
                 : `已儲存 ${rows.length} 個框`);
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
    nav.back = showPreview;

    const p = pending('排版中…');
    try {
      const blocks = (await db.getBy('blocks', 'pageId', current.id))
        .sort((a, b) => a.order - b.order);
      const { renderPage } = await import('../render/canvas.js');
      const { processedBlob } = await import('../input/pages.js');

      const W = current.procW || current.origW;
      const H = current.procH || current.origH;
      const scale = Math.min(1, 900 / Math.max(W, H));

      // 帶進影像與圖片框，預覽才會和匯出長得一樣（插圖、圖內文字的覆蓋）
      const src = await processedBlob(current);
      const bmp = src ? await blobToBitmap(src) : null;
      const figs = bmp ? await db.getBy('figures', 'pageId', current.id) : [];

      const { canvas, report } = renderPage({ width: W, height: H }, blocks,
        { scale, showBoxes: true, image: bmp, figures: figs });
      bmp?.close?.();

      const wrap = document.createElement('div');
      wrap.className = 'compare';

      const source = await processedBlob(current);
      if (source) {
        const left = document.createElement('figure');
        left.className = 'compare-cell';
        const lc = document.createElement('figcaption');
        lc.textContent = '原頁';
        const img = document.createElement('img');
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = URL.createObjectURL(source);
        img.src = objectUrl;
        left.append(lc, img);
        wrap.append(left);
      } else {
        // EPUB 沒有原頁可比，只顯示重排結果
        wrap.style.gridTemplateColumns = '1fr';
      }

      const right = document.createElement('figure');
      right.className = 'compare-cell';
      const rc = document.createElement('figcaption');
      rc.textContent = source ? '重排結果' : '排版結果';
      right.append(rc, canvas);
      wrap.append(right);
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
      btn('回到書籍', '', () => go('project', { id: current.projectId })),
    );
  }

  /* ---------- 校正模式 ---------- */

  async function showEditor() {
    stage.replaceChildren();
    bar.replaceChildren();
    nav.back = showPreview;    // 校正到一半按返回時退回檢視，不要直接離開

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
    // 佔位符對使用者沒有意義，顯示時換回原本的公式文字
    src.textContent = inlineMath(b.srcText, b.mathSpans).replace(/\n/g, '⏎');
    body.append(src);

    if (b.mathSpans?.length) {
      const m = document.createElement('p');
      m.className = 'block-note';
      m.textContent =
        `偵測到 ${b.mathSpans.length} 個行內公式，匯出時會用原書裁下來的小圖`;
      body.append(m);
    }

    /* 模型認為 OCR 讀錯字並依前後文修正過。
       要讓使用者看得到修正內容，才判斷得出這個修正該不該接受。 */
    if (b.srcFixed) {
      const fix = document.createElement('p');
      fix.className = 'block-fixed';
      fix.textContent = 'AI 判讀修正：' + b.srcFixed.replace(/\n/g, '⏎');
      body.append(fix);
    }

    if (b.skipTranslate) {
      const note = document.createElement('p');
      note.className = 'block-note';
      note.textContent = '不翻譯，匯出時從原圖裁切貼回';
      body.append(note);
    } else if (b.kind === 'figuretext' && b.dstText) {
      const dst = document.createElement('p');
      dst.className = 'block-dst';
      dst.textContent = inlineMath(b.dstText, b.mathSpans).replace(/\n/g, '⏎');
      const note = document.createElement('p');
      note.className = 'block-note';
      note.textContent = '匯出時會蓋掉插圖上的原字，把這段中譯寫上去';
      body.append(dst, note);
    } else if (b.dstText) {
      const dst = document.createElement('p');
      dst.className = 'block-dst';
      dst.textContent = inlineMath(b.dstText, b.mathSpans).replace(/\n/g, '⏎');
      body.append(dst);
    } else if (b.error) {
      const err = document.createElement('p');
      err.className = 'block-note bad';
      err.textContent = b.error;
      body.append(err);
    }

    const actions = document.createElement('div');
    actions.className = 'block-actions';

    const editSrc = document.createElement('button');
    editSrc.className = 'link';
    editSrc.textContent = '修正原文';
    editSrc.addEventListener('click', () => editSource(b));
    actions.append(editSrc);

    if (b.dstText != null || b.error) {
      const again = document.createElement('button');
      again.className = 'link';
      again.textContent = '重跑這一塊';
      again.addEventListener('click', () => retryBlock(b));
      actions.append(again);
    }

    if (b.srcFixed) {
      const accept = document.createElement('button');
      accept.className = 'link';
      accept.textContent = '採用修正後的原文';
      accept.addEventListener('click', async () => {
        await db.put('blocks', { ...b, srcText: b.srcFixed, srcFixed: null });
        ok('已採用');
        showPreview();
      });
      actions.append(accept);
    }

    if (!b.skipTranslate) {
      const ind = document.createElement('button');
      ind.className = 'link';
      ind.textContent = b.indent ? '取消段首縮排' : '設為段首縮排';
      ind.addEventListener('click', async () => {
        await db.put('blocks', { ...b, indent: !b.indent });
        showPreview();
      });
      actions.append(ind);
    }

    body.append(actions);
    li.append(tags, body);
    return li;
  }

  /**
   * 修正 OCR 讀錯的原文。
   * OCR 認錯字的話，翻譯再怎麼重跑都不會對 —— 得先能改原文。
   */
  async function editSource(b) {
    if (b.mathSpans?.length) {
      const yes = await askConfirm('這一塊含有行內公式', {
        detail:
          `原文裡的 ⟦M1⟧ 這種記號代表 ${b.mathSpans.length} 個公式圖片。\n` +
          '編輯時請原樣保留，刪掉的話那個公式就不會出現在成品裡。',
        okLabel: '繼續編輯',
      });
      if (!yes) return;
    }

    const next = await askTextarea('修正原文', {
      value: b.srcText,
      okLabel: '儲存',
      hint: '這是 OCR 讀到的原文。改完可以選擇要不要立刻重新翻譯。\n' +
            '換行代表原書的斷行，會影響重排結果，請保留。',
    });
    if (next === null || next === b.srcText) return;

    const trimmed = next.trim();
    if (!trimmed) {
      const yes = await askConfirm('原文清空了，要刪掉這一塊嗎？', {
        detail: '空的文字塊不會出現在成品 PDF 裡。',
        okLabel: '刪除', danger: true,
      });
      if (!yes) return;
      await db.del('blocks', b.id);
      ok('已刪除這一塊');
      return showPreview();
    }

    // 原文變了，舊譯文就過期了，留著只會誤導
    await db.put('blocks', { ...b, srcText: next, dstText: null, error: null });

    const retranslate = await askConfirm('原文已更新，要立刻重新翻譯嗎？', {
      detail: '不重新翻譯的話，這一塊在下次執行整本翻譯時會被一併處理。',
      okLabel: '立刻翻譯',
    });
    if (!retranslate) {
      ok('已儲存');
      return showPreview();
    }
    retryBlock({ ...b, srcText: next, dstText: null });
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
