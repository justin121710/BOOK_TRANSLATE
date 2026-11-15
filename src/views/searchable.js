import { setTitle, tpl } from '../ui/router.js';

export default function searchableView(root) {
  setTitle('PDF 加上文字層');
  root.append(tpl('tpl-searchable'));
  const form = root.querySelector('form');
  const fileInput = form.querySelector('#searchableFile');
  const language = form.querySelector('#searchableLanguage');
  const watermarks = form.querySelector('#searchableWatermarks');
  const hideLayers = form.querySelector('#searchableHideLayers');
  const preview = root.querySelector('#searchablePreview');
  const previewImage = root.querySelector('#searchablePreviewImage');
  const previewTitle = root.querySelector('#searchablePreviewTitle');
  const previewRemoved = root.querySelector('#searchablePreviewRemoved');
  const previewText = root.querySelector('#searchablePreviewText');
  const start = form.querySelector('#searchableStart');
  const cancel = form.querySelector('#searchableCancel');
  const status = root.querySelector('#searchableStatus');
  const download = root.querySelector('#searchableDownload');
  let controller;
  let outputUrl;
  let previewUrl;

  function clearOutput() {
    if (outputUrl) URL.revokeObjectURL(outputUrl);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    outputUrl = previewUrl = null;
    previewImage.removeAttribute('src');
    preview.open = false;
    preview.hidden = true;
    download.removeAttribute('href');
    download.hidden = true;
  }

  function resetOutput() {
    clearOutput();
    status.textContent = '';
  }
  form.addEventListener('change', resetOutput);
  watermarks.addEventListener('input', resetOutput);

  cancel.addEventListener('click', () => controller?.abort());

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const file = fileInput.files?.[0];
    if (!file || controller) return;
    clearOutput();
    controller = new AbortController();
    const { signal } = controller;
    fileInput.disabled = language.disabled = watermarks.disabled = hideLayers.disabled = start.disabled = true;
    cancel.hidden = false;
    status.textContent = '正在開啟 PDF…';

    try {
      const { makeSearchablePdf } = await import('../pdf/searchable.js');
      const result = await makeSearchablePdf(file, {
        language: language.value,
        watermarkText: watermarks.value,
        hideWatermarkLayers: hideLayers.checked,
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
      if (result.filteredMatches) {
        notes.push(`排除浮水印文字 ${result.filteredMatches} 處。`);
      } else if (watermarks.value.trim()) {
        notes.push('未比對到輸入的浮水印字樣。');
      }
      if (hideLayers.checked) {
        notes.push(`OCR 暫時隱藏 ${result.hiddenLayers} 個標為浮水印的圖層。`);
      }
      if (result.rebuiltPages) notes.push(`以原頁影像重建 ${result.rebuiltPages} 頁。`);
      if (result.preview) {
        previewUrl = URL.createObjectURL(result.preview.image);
        previewImage.src = previewUrl;
        previewTitle.textContent = `預覽第 ${result.preview.page} 頁的過濾結果`;
        previewRemoved.textContent = result.preview.removed.join('、');
        previewText.textContent = result.preview.text || '這頁未保留可嵌入的文字。';
        preview.hidden = false;
      }
      if (result.emptyPages.length) notes.push(`未取得可嵌入文字的頁面：${result.emptyPages.join('、')}。`);
      if (result.missing.length) {
        notes.push(`字型缺少 ${result.missing.length} 個辨識出的字元（如 ${result.missing.slice(0, 12).join('、')}），請對照原頁。`);
      }
      status.textContent = notes.join(' ');
    } catch (error) {
      status.textContent = signal.aborted ? '已取消。' : `處理失敗：${error.message}`;
    } finally {
      controller = null;
      fileInput.disabled = language.disabled = watermarks.disabled = hideLayers.disabled = start.disabled = false;
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
