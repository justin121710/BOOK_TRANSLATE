import { setTitle, tpl } from '../ui/router.js';

export default function searchableView(root) {
  setTitle('PDF 加上文字層');
  root.append(tpl('tpl-searchable'));
  const form = root.querySelector('form');
  const fileInput = form.querySelector('#searchableFile');
  const language = form.querySelector('#searchableLanguage');
  const start = form.querySelector('#searchableStart');
  const cancel = form.querySelector('#searchableCancel');
  const status = root.querySelector('#searchableStatus');
  const download = root.querySelector('#searchableDownload');
  let controller;
  let outputUrl;

  function clearOutput() {
    if (outputUrl) URL.revokeObjectURL(outputUrl);
    outputUrl = null;
    download.removeAttribute('href');
    download.hidden = true;
  }

  form.addEventListener('change', () => {
    clearOutput();
    status.textContent = '';
  });

  cancel.addEventListener('click', () => controller?.abort());

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const file = fileInput.files?.[0];
    if (!file || controller) return;
    clearOutput();
    controller = new AbortController();
    const { signal } = controller;
    fileInput.disabled = language.disabled = start.disabled = true;
    cancel.hidden = false;
    status.textContent = '正在開啟 PDF…';

    try {
      const { makeSearchablePdf } = await import('../pdf/searchable.js');
      const result = await makeSearchablePdf(file, {
        language: language.value,
        signal,
        onProgress: (page, total) => {
          status.textContent = page ? `正在檢查或辨識第 ${page}／${total} 頁…` : '正在加入文字層…';
        },
      });
      signal.throwIfAborted();
      outputUrl = URL.createObjectURL(result.blob);
      download.href = outputUrl;
      download.download = file.name.replace(/\.pdf$/i, '') + '_可搜尋.pdf';
      download.hidden = false;

      const notes = [`完成。加入文字層 ${result.addedPages} 頁，沿用既有文字層 ${result.existingPages} 頁。`];
      if (result.emptyPages.length) notes.push(`未取得可嵌入文字的頁面：${result.emptyPages.join('、')}。`);
      if (result.missing.length) {
        notes.push(`字型缺少 ${result.missing.length} 個辨識出的字元（如 ${result.missing.slice(0, 12).join('、')}），請對照原頁。`);
      }
      status.textContent = notes.join(' ');
    } catch (error) {
      status.textContent = signal.aborted ? '已取消。' : `處理失敗：${error.message}`;
    } finally {
      controller = null;
      fileInput.disabled = language.disabled = start.disabled = false;
      cancel.hidden = true;
    }
  });

  return {
    teardown() {
      controller?.abort();
      clearOutput();
    },
  };
}
