import { setTitle, go } from '../ui/router.js';
import { askText, askConfirm } from '../ui/dialog.js';
import { icon } from '../ui/icons.js';
import { toast, bad, pending } from '../ui/toast.js';
import * as db from '../state/db.js';
import { settings } from '../state/settings.js';
import { addImagePage, listPages } from '../input/pages.js';

const STATUS = {
  pending:    { label: '待處理', cls: '' },
  ocr:        { label: '已辨識', cls: 'busy' },
  translated: { label: '已翻譯', cls: 'busy' },
  done:       { label: '完成',   cls: 'ok' },
  failed:     { label: '失敗',   cls: 'bad' },
};

export default async function projectView(root, { id }) {
  const project = id && await db.get('projects', id);
  if (!project) return notFound(root);

  setTitle(project.name);

  const urls = [];   // 縮圖的 object URL，離開這頁要全部收回
  const sec = document.createElement('section');
  sec.className = 'view pad';

  /* ---------- 標題列 ---------- */

  const head = document.createElement('div');
  head.className = 'row-between';
  const h = document.createElement('h2');
  h.textContent = project.name;
  const backup = document.createElement('button');
  backup.className = 'btn';
  backup.append(icon('download', { size: 17 }));
  const backupLabel = document.createElement('span');
  backupLabel.textContent = '備份';
  backup.append(backupLabel);
  backup.addEventListener('click', runBackup);

  const rename = document.createElement('button');
  rename.className = 'btn';
  rename.textContent = '改名';
  rename.addEventListener('click', async () => {
    const next = await askText('書名', { value: project.name, okLabel: '儲存' });
    if (next === null) return;
    project.name = next.trim() || project.name;
    project.updatedAt = Date.now();
    await db.put('projects', project);
    setTitle(project.name);
    h.textContent = project.name;
  });
  const headBtns = document.createElement('div');
  headBtns.className = 'row-gap';
  headBtns.style.margin = '0';
  headBtns.append(backup, rename);
  head.append(h, headBtns);

  async function runBackup() {
    const p = pending('打包中…');
    try {
      const { exportProject, backupName } = await import('../state/backup.js');
      const blob = await exportProject(project.id, {
        onProgress: (n, total, pct) =>
          p.update(pct != null ? `壓縮中 ${Math.round(pct)}%` : `打包中 ${n}/${total}`),
      });
      const { download } = await import('../pdf/export.js');
      download(blob, backupName(project.name));
      p.done(`備份完成 ${(blob.size / 1048576).toFixed(1)} MB`, 'ok');
    } catch (e) {
      p.done();
      bad('備份失敗：' + e.message);
    }
  }

  /* ---------- 匯入 ---------- */

  const bar = document.createElement('div');
  bar.className = 'row-gap';

  const camera = fileInput('image/*', true, 'camera');
  const album  = fileInput('image/*', true);
  const pdfIn  = fileInput('application/pdf,.pdf', false);
  const epubIn = fileInput('application/epub+zip,.epub', false);

  bar.append(
    action('拍書頁', () => camera.click(), 'camera'),
    action('從相簿', () => album.click(), 'image'),
    action('PDF',   () => pdfIn.click(), 'file'),
    action('EPUB',  () => epubIn.click(), 'book'),
    camera, album, pdfIn, epubIn,
  );

  camera.addEventListener('change', () => intakeImages(camera, 'camera'));
  album.addEventListener('change', () => intakeImages(album, 'photo'));
  pdfIn.addEventListener('change', intakePdf);
  epubIn.addEventListener('change', intakeEpub);

  /* ---------- 頁面格線 ---------- */

  /* ---------- 處理 ---------- */

  const runBar = document.createElement('div');
  runBar.className = 'row-gap';
  const ocrBtn = action('辨識文字', runOcr, 'scan');
  const trBtn = action('翻譯', runTranslate, 'translate');
  const pdfBtn = action('匯出 PDF', runExport, 'download');
  pdfBtn.classList.add('btn-primary');
  runBar.append(ocrBtn, trBtn, pdfBtn);

  const grid = document.createElement('div');
  grid.className = 'page-grid';

  const empty = document.createElement('div');
  empty.className = 'banner banner-info';
  empty.textContent =
    '還沒有任何頁面。拍書頁時盡量把書壓平、讓整頁都入鏡，' +
    '匯入後可以拖四個角做透視校正。';

  sec.append(head, bar, runBar, empty, grid);
  root.append(sec);

  await paint();

  return { teardown: () => urls.forEach(u => URL.revokeObjectURL(u)) };

  /* ---------- 內部 ---------- */

  function action(label, onClick, iconName) {
    const b = document.createElement('button');
    b.className = 'btn';
    if (iconName) b.append(icon(iconName, { size: 18 }));
    const span = document.createElement('span');
    span.textContent = label;
    b.append(span);
    b.addEventListener('click', onClick);
    return b;
  }

  function fileInput(accept, multiple, capture) {
    const i = document.createElement('input');
    i.type = 'file';
    i.accept = accept;
    i.multiple = multiple;
    if (capture) i.capture = capture;
    i.hidden = true;
    return i;
  }

  async function intakeImages(input, source) {
    const files = [...input.files];
    input.value = '';
    if (!files.length) return;

    const p = pending(`匯入 0/${files.length}`);
    let done = 0;
    for (const f of files) {
      try {
        await addImagePage(project.id, f, { source });
      } catch (e) {
        bad(`${f.name}：${e.message}`);
      }
      p.update(`匯入 ${++done}/${files.length}`);
      await new Promise(r => setTimeout(r, 0));
    }
    p.done(`已匯入 ${done} 頁`, 'ok');
    await db.touchProject(project.id);
    paint();
  }

  async function intakePdf() {
    const file = pdfIn.files?.[0];
    pdfIn.value = '';
    if (!file) return;

    const p = pending('開啟 PDF…');
    try {
      // pdf.js 有一大包，用到才載
      const { importPdf, openPdf, probeNativeText } = await import('../input/pdfin.js');

      const doc = await openPdf(file);
      const probe = await probeNativeText(doc);
      const total = doc.numPages;
      doc.destroy();
      p.done();

      const detail = probe.hasNativeText
        ? `這份 PDF 有原生文字層（每頁約 ${probe.avgChars} 字），可以直接取用精確座標，不需要 OCR，也不會產生 Vision 費用。`
        : '這份 PDF 沒有可用的文字層，看起來是掃描件，每一頁都會送 Google Vision 辨識。';

      const yes = await askConfirm(`匯入 ${total} 頁？`, {
        detail, okLabel: '匯入',
      });
      if (!yes) return;

      const q = pending('轉換中 0/' + total);
      await importPdf(project.id, file, {
        onProgress: (n, t) => q.update(`轉換中 ${n}/${t}`),
      });
      q.done(`已匯入 ${total} 頁`, 'ok');
      await db.touchProject(project.id);
      paint();
    } catch (e) {
      p.done();
      bad(e.message);
    }
  }

  async function intakeEpub() {
    const file = epubIn.files?.[0];
    epubIn.value = '';
    if (!file) return;

    const existing = await listPages(project.id);
    if (existing.length) {
      bad('這本書已經有頁面了。EPUB 會重新編排整本書，請建立一本新的書再匯入。');
      return;
    }

    const p = pending('解析 EPUB…');
    try {
      const { parseEpub, summarise } = await import('../input/epubin.js');
      const book = await parseEpub(file);
      const s = summarise(book);
      p.done();

      const yes = await askConfirm(`匯入《${book.title}》？`, {
        detail:
          `${s.chapters} 章、${s.paragraphs} 段、約 ${s.chars.toLocaleString()} 字。\n\n` +
          'EPUB 是可重排的 HTML，檔案裡不存在原始頁面座標，' +
          '所以無法「照原排版還原」。這條路會用統一的書籍版式重新排成一本乾淨的中譯書，' +
          '分頁不會和原書一致，也沒有插圖。\n\n' +
          '振り仮名（ruby 標記）會直接移除。',
        okLabel: '匯入',
      });
      if (!yes) return;

      const q = pending('編排中…');
      const { buildPages } = await import('../input/epubpage.js');
      const r = await buildPages(project.id, book);

      if (project.name === '未命名書籍' || !project.name.trim()) {
        project.name = book.title;
        await db.put('projects', project);
        setTitle(project.name);
        h.textContent = project.name;
      }
      await db.touchProject(project.id);
      q.done(`已編排 ${r.pages} 頁、${r.blocks} 個段落`, 'ok');
      paint();
    } catch (e) {
      p.done();
      bad('EPUB 解析失敗：' + e.message);
    }
  }

  async function runOcr() {
    const pages = await listPages(project.id);
    // EPUB 是純文字，本來就沒有東西要辨識
    const todo = pages.filter(p =>
      p.source !== 'epub' && (p.status === 'pending' || p.status === 'failed'));

    if (!todo.length) {
      toast(pages.some(p => p.source === 'epub') ? 'EPUB 不需要辨識，直接翻譯即可'
          : pages.length ? '所有頁面都已經辨識過了'
          : '還沒有頁面');
      return;
    }
    if (!settings.googleKey && todo.some(p => !p.nativeText?.length)) {
      bad('尚未設定 Google Cloud Vision 金鑰');
      return;
    }

    const free = todo.filter(p => p.nativeText?.length).length;
    const paid = todo.length - free;
    const uncorrected = todo.filter(p => !p.corners && !p.nativeText?.length).length;

    // 圖片框要在辨識之前畫好：框內的文字才會被歸成「圖內文字」走覆蓋那條路
    let withFigures = 0;
    for (const pg of todo) {
      if ((await db.getBy('figures', 'pageId', pg.id)).length) withFigures++;
    }

    const detail = [
      paid ? `${paid} 頁會送 Google Vision 辨識，約 US$${(paid * 0.0015).toFixed(3)}（每月前 1000 頁免費）。` : '',
      free ? `${free} 頁有原生文字層，直接取用座標，不花錢。` : '',
      uncorrected ? `\n注意：有 ${uncorrected} 頁還沒做透視校正。拍歪的頁面直接辨識，座標會跟著歪，重排後會對不上。` : '',
      withFigures < todo.length
        ? `\n提醒：有 ${todo.length - withFigures} 頁還沒畫圖片框。` +
          '框內的文字會被歸成「圖內文字」，匯出時蓋掉原字寫上中譯；' +
          '沒先畫的話那些字會被當成正文抽出來重排。建議先進單頁畫好再辨識。'
        : '',
    ].filter(Boolean).join('\n');

    const yes = await askConfirm(`辨識 ${todo.length} 頁？`, { detail, okLabel: '開始' });
    if (!yes) return;

    ocrBtn.disabled = true;
    const p = pending(`辨識中 0/${todo.length}`);
    let wake = null;
    try {
      // 手機螢幕一暗就會凍住背景工作，批次跑到一半停掉最讓人惱火
      wake = await navigator.wakeLock?.request('screen').catch(() => null);

      const { recognisePages } = await import('../ocr/index.js');
      const res = await recognisePages(todo, {
        onProgress: (n, total) => p.update(`辨識中 ${n}/${total}`),
      });

      if (res.failed) {
        p.done(`完成 ${res.done} 頁，失敗 ${res.failed} 頁`, 'bad');
        for (const e of res.errors.slice(0, 3)) bad(`第 ${e.page} 頁：${e.message}`);
      } else {
        p.done(`已辨識 ${res.done} 頁`, 'ok');
      }
      await db.touchProject(project.id);
    } catch (e) {
      p.done();
      bad('辨識失敗：' + e.message);
    } finally {
      wake?.release?.().catch(() => {});
      ocrBtn.disabled = false;
      paint();
    }
  }

  async function runTranslate() {
    const pages = await listPages(project.id);
    const todo = pages.filter(p => p.status === 'ocr' || p.status === 'failed');

    if (!todo.length) {
      toast(pages.some(p => p.status === 'pending')
        ? '請先執行「辨識文字」'
        : '沒有待翻譯的頁面');
      return;
    }
    const p0 = pending('估算費用…');
    let est, tr;
    try {
      tr = await import('../translate/index.js');
      if (!tr.providerReady()) {
        p0.done();
        bad(settings.provider === 'gemini'
          ? '尚未設定 Google 金鑰（Gemini 可沿用 Vision 那把）'
          : '尚未設定 Anthropic 金鑰');
        return;
      }
      est = await tr.estimateBatch(todo);
    } catch (e) {
      p0.done();
      bad(e.message);
      return;
    }
    p0.done();

    if (!est.blockCount) {
      toast('這些頁面都已經翻譯過了');
      return;
    }

    const yes = await askConfirm(`翻譯 ${todo.length} 頁？`, {
      detail:
        `共 ${est.blockCount} 個文字塊，使用 ${est.model}。\n` +
        `估計花費約 US$${est.cost.toFixed(3)}（輸入約 ${est.input.toLocaleString()} token，` +
        `輸出約 ${est.output.toLocaleString()} token）。\n\n` +
        '這是估算值，實際以供應商帳單為準。頁面會依序處理，' +
        '好讓專有名詞的譯法能跨頁累積並保持一致。' +
        (todo.some(p => p.source === 'epub')
          ? '\n\n翻譯完成後會依中譯重新分頁：中文比日文短，' +
            '沿用原文的版面每頁都會留下大片空白。'
          : ''),
      okLabel: '開始翻譯',
    });
    if (!yes) return;

    trBtn.disabled = true;
    const p = pending(`翻譯中 0/${todo.length}`);
    let wake = null;
    try {
      wake = await navigator.wakeLock?.request('screen').catch(() => null);
      const res = await tr.translatePages(todo, {
        bookName: project.name,
        onProgress: (n, total, acc) =>
          p.update(`翻譯中 ${n}/${total}　US$${acc.cost.toFixed(3)}`),
      });

      if (res.failed) {
        p.done(`完成 ${res.done} 頁，失敗 ${res.failed} 頁　US$${res.cost.toFixed(3)}`, 'bad');
        for (const e of res.errors.slice(0, 3)) bad(`第 ${e.page} 頁：${e.message}`);
      } else {
        // EPUB 要依中譯重排：用日文原文排出來的版面會留下大片空白
        if (todo.some(pg => pg.source === 'epub')) {
          p.update('依中譯重新分頁…');
          const { repaginate } = await import('../input/epubpage.js');
          const r = await repaginate(project.id);
          p.done(r ? `已翻譯並重排為 ${r.pages} 頁　US$${res.cost.toFixed(3)}`
                   : `已翻譯 ${res.done} 頁　US$${res.cost.toFixed(3)}`, 'ok');
        } else {
          p.done(`已翻譯 ${res.done} 頁　US$${res.cost.toFixed(3)}`, 'ok');
        }
      }
      await db.touchProject(project.id);
    } catch (e) {
      p.done();
      bad('翻譯失敗：' + e.message);
    } finally {
      wake?.release?.().catch(() => {});
      trBtn.disabled = false;
      paint();
    }
  }

  async function runExport() {
    const pages = await listPages(project.id);
    const ready = pages.filter(p => p.status === 'translated' || p.status === 'done');

    if (!ready.length) {
      toast(pages.length ? '還沒有已翻譯的頁面' : '還沒有頁面');
      return;
    }

    const withOriginal = await askExportOptions(ready.length);
    if (withOriginal === null) return;

    pdfBtn.disabled = true;
    const p = pending('準備匯出…');
    let wake = null;
    try {
      wake = await navigator.wakeLock?.request('screen').catch(() => null);
      const { exportPdf, download } = await import('../pdf/export.js');

      const { blob, warnings } = await exportPdf(project, ready, {
        withOriginal,
        onProgress: (n, total, note) => p.update(`匯出中 ${n}/${total}　${note || ''}`),
      });

      const name = `${(project.name || '未命名書籍').replace(/[\\/:*?"<>|]/g, '_')}.pdf`;
      download(blob, name);
      p.done(`已匯出 ${(blob.size / 1048576).toFixed(1)} MB`, 'ok');

      for (const w of warnings.slice(0, 3)) bad(w.message);
      if (warnings.length > 3) bad(`另有 ${warnings.length - 3} 項提醒`);

      for (const pg of ready) await db.put('pages', { ...pg, status: 'done' });
      await db.touchProject(project.id);
    } catch (e) {
      p.done();
      bad('匯出失敗：' + e.message);
    } finally {
      wake?.release?.().catch(() => {});
      pdfBtn.disabled = false;
      paint();
    }
  }

  /** @returns {Promise<boolean|null>} true=附原頁對照，false=純中譯，null=取消 */
  function askExportOptions(count) {
    return new Promise(resolve => {
      const body = document.createElement('div');
      const label = document.createElement('label');
      label.className = 'check-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      const span = document.createElement('span');
      span.textContent = '附上原頁掃描對照（奇數頁原文、偶數頁中譯）';
      label.append(cb, span);

      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = `共 ${count} 頁。勾選對照會讓頁數與檔案大小都變成兩倍。`;

      body.append(label, hint);

      const dlg = document.createElement('dialog');
      dlg.className = 'dlg';
      const form = document.createElement('form');
      form.method = 'dialog';
      const h = document.createElement('h3');
      h.className = 'dlg-title';
      h.textContent = '匯出 PDF';
      const row = document.createElement('div');
      row.className = 'dlg-actions';

      let settled = false;
      const done = v => { if (!settled) { settled = true; resolve(v); } };

      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn';
      cancel.textContent = '取消';
      cancel.addEventListener('click', () => { done(null); dlg.close(); });

      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'btn btn-primary';
      go.textContent = '匯出';
      go.addEventListener('click', () => { done(cb.checked); dlg.close(); });

      row.append(cancel, go);
      form.append(h, body, row);
      dlg.append(form);
      document.body.append(dlg);
      dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
      dlg.addEventListener('close', () => { done(null); dlg.remove(); });
      dlg.showModal();
    });
  }

  async function paint() {
    urls.splice(0).forEach(u => URL.revokeObjectURL(u));

    const pages = await listPages(project.id);
    empty.hidden = pages.length > 0;
    ocrBtn.disabled = pages.length === 0;
    trBtn.disabled = pages.length === 0;
    pdfBtn.disabled = !pages.some(p => p.status === 'translated' || p.status === 'done');
    grid.replaceChildren();

    for (const page of pages) {
      const cell = document.createElement('button');
      cell.className = 'page-cell';
      cell.addEventListener('click', () => go('page', { id: page.id }));

      let img;
      const blob = page.procBlob || page.origBlob;
      if (blob) {
        img = document.createElement('img');
        const url = URL.createObjectURL(blob);
        urls.push(url);
        img.src = url;
        img.alt = `第 ${page.index + 1} 頁`;
        img.loading = 'lazy';
      } else {
        // EPUB 那條路沒有掃描影像，畫一個純文字的縮圖示意
        img = document.createElement('div');
        img.className = 'page-textonly';
        img.textContent = '文字';
      }

      const num = document.createElement('span');
      num.className = 'page-num';
      num.textContent = page.index + 1;

      const st = STATUS[page.status] || STATUS.pending;
      const pill = document.createElement('span');
      pill.className = 'pill ' + st.cls;
      pill.textContent = st.label;

      const marks = document.createElement('span');
      marks.className = 'page-marks';
      if (page.nativeText) marks.append(mark('type', '有原生文字層，不需要 OCR'));
      if (!page.corners) marks.append(mark('crop', '尚未透視校正'));

      cell.append(img, num, pill, marks);
      grid.append(cell);
    }
  }

  function mark(iconName, title) {
    const s = document.createElement('i');
    s.className = 'page-mark';
    s.append(icon(iconName, { size: 13, stroke: 2.2 }));
    s.title = title;
    return s;
  }
}

function notFound(root) {
  setTitle('找不到這本書');
  const p = document.createElement('section');
  p.className = 'view pad';
  p.innerHTML = `<h2>找不到這本書</h2>
    <p class="hint">它可能已經被刪除了。</p>
    <button class="btn" data-go="home">回到書櫃</button>`;
  root.append(p);
}
