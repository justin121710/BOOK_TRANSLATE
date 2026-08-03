import { setTitle, go } from '../ui/router.js';
import { askText, askConfirm } from '../ui/dialog.js';
import { toast, ok, bad, pending } from '../ui/toast.js';
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
  head.append(h, rename);

  /* ---------- 匯入 ---------- */

  const bar = document.createElement('div');
  bar.className = 'row-gap';

  const camera = fileInput('image/*', true, 'camera');
  const album  = fileInput('image/*', true);
  const pdfIn  = fileInput('application/pdf,.pdf', false);
  const epubIn = fileInput('application/epub+zip,.epub', false);

  bar.append(
    action('📷 拍書頁', () => camera.click()),
    action('🖼 從相簿', () => album.click()),
    action('📄 PDF',   () => pdfIn.click()),
    action('📕 EPUB',  () => epubIn.click()),
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
  const ocrBtn = action('🔍 辨識文字', runOcr);
  const trBtn = action('🌏 翻譯', runTranslate);
  trBtn.classList.add('btn-primary');
  runBar.append(ocrBtn, trBtn);

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

  function action(label, onClick) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = label;
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
    epubIn.value = '';
    await askConfirm('EPUB 匯入尚未實作', {
      detail:
        'EPUB 是可重排的 HTML，檔案裡不存在原始頁面座標，' +
        '所以無法「照原排版還原」。這條路會用統一的書籍版式重新排版成一本乾淨的中譯書，' +
        '分頁不會和原書一致。這部分排在 M8。',
      okLabel: '知道了',
    });
  }

  async function runOcr() {
    const pages = await listPages(project.id);
    const todo = pages.filter(p => p.status === 'pending' || p.status === 'failed');

    if (!todo.length) {
      toast(pages.length ? '所有頁面都已經辨識過了' : '還沒有頁面');
      return;
    }
    if (!settings.googleKey && todo.some(p => !p.nativeText?.length)) {
      bad('尚未設定 Google Cloud Vision 金鑰');
      return;
    }

    const free = todo.filter(p => p.nativeText?.length).length;
    const paid = todo.length - free;
    const uncorrected = todo.filter(p => !p.corners && !p.nativeText?.length).length;

    const detail = [
      paid ? `${paid} 頁會送 Google Vision 辨識，約 US$${(paid * 0.0015).toFixed(3)}（每月前 1000 頁免費）。` : '',
      free ? `${free} 頁有原生文字層，直接取用座標，不花錢。` : '',
      uncorrected ? `\n注意：有 ${uncorrected} 頁還沒做透視校正。拍歪的頁面直接辨識，座標會跟著歪，重排後會對不上。` : '',
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
    if (!settings.claudeKey) {
      bad('尚未設定 Anthropic 金鑰');
      return;
    }

    const p0 = pending('估算費用…');
    let est;
    try {
      const { estimateBatch } = await import('../translate/index.js');
      est = await estimateBatch(todo);
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

    const model = settings.model === 'claude-opus-5' ? 'Opus 5' : 'Sonnet 5';
    const yes = await askConfirm(`翻譯 ${todo.length} 頁？`, {
      detail:
        `共 ${est.blockCount} 個文字塊，使用 ${model}。\n` +
        `估計花費約 US$${est.cost.toFixed(3)}（輸入約 ${est.input.toLocaleString()} token，` +
        `輸出約 ${est.output.toLocaleString()} token）。\n\n` +
        '這是估算值，實際以 Anthropic 帳單為準。頁面會依序處理，' +
        '好讓專有名詞的譯法能跨頁累積並保持一致。',
      okLabel: '開始翻譯',
    });
    if (!yes) return;

    trBtn.disabled = true;
    const p = pending(`翻譯中 0/${todo.length}`);
    let wake = null;
    try {
      wake = await navigator.wakeLock?.request('screen').catch(() => null);
      const { translatePages } = await import('../translate/index.js');
      const res = await translatePages(todo, {
        bookName: project.name,
        onProgress: (n, total, acc) =>
          p.update(`翻譯中 ${n}/${total}　US$${acc.cost.toFixed(3)}`),
      });

      if (res.failed) {
        p.done(`完成 ${res.done} 頁，失敗 ${res.failed} 頁　US$${res.cost.toFixed(3)}`, 'bad');
        for (const e of res.errors.slice(0, 3)) bad(`第 ${e.page} 頁：${e.message}`);
      } else {
        p.done(`已翻譯 ${res.done} 頁　US$${res.cost.toFixed(3)}`, 'ok');
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

  async function paint() {
    urls.splice(0).forEach(u => URL.revokeObjectURL(u));

    const pages = await listPages(project.id);
    empty.hidden = pages.length > 0;
    ocrBtn.disabled = pages.length === 0;
    trBtn.disabled = pages.length === 0;
    grid.replaceChildren();

    for (const page of pages) {
      const cell = document.createElement('button');
      cell.className = 'page-cell';
      cell.addEventListener('click', () => go('page', { id: page.id }));

      const img = document.createElement('img');
      const url = URL.createObjectURL(page.procBlob || page.origBlob);
      urls.push(url);
      img.src = url;
      img.alt = `第 ${page.index + 1} 頁`;
      img.loading = 'lazy';

      const num = document.createElement('span');
      num.className = 'page-num';
      num.textContent = page.index + 1;

      const st = STATUS[page.status] || STATUS.pending;
      const pill = document.createElement('span');
      pill.className = 'pill ' + st.cls;
      pill.textContent = st.label;

      const marks = document.createElement('span');
      marks.className = 'page-marks';
      if (page.nativeText) marks.append(mark('T', '有原生文字層，不需要 OCR'));
      if (!page.corners) marks.append(mark('◳', '尚未透視校正'));

      cell.append(img, num, pill, marks);
      grid.append(cell);
    }
  }

  function mark(text, title) {
    const s = document.createElement('i');
    s.className = 'page-mark';
    s.textContent = text;
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
