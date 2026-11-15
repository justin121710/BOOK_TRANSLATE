import { setTitle, tpl } from '../ui/router.js';
import { changes, deleteOutput, discardJob, job, restoreJob, runJob } from '../state/searchable-job.js';

export default function searchableView(root) {
  setTitle('PDF 加上文字層');
  root.append(tpl('tpl-searchable'));
  const form = root.querySelector('form');
  const field = name => root.querySelector('#searchable' + name);
  const fileInput = field('File');
  const language = field('Language');
  const watermarks = field('Watermarks');
  const hideLayers = field('HideLayers');
  const imageCopy = field('ImageCopy');
  const preview = field('Preview');
  const previewImage = field('PreviewImage');
  const start = field('Start');
  const cancel = field('Cancel');
  const resume = field('Resume');
  const discard = field('Discard');
  const pendingLabel = field('Pending');
  const status = field('Status');
  const download = field('Download');
  const remove = field('DeleteOutput');
  let renderedOutput;
  let outputUrl;
  let previewUrl;

  function releaseUrls() {
    if (outputUrl) URL.revokeObjectURL(outputUrl);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    outputUrl = previewUrl = null;
  }

  function showOutput() {
    if (renderedOutput === job.output) return;
    renderedOutput = job.output;
    releaseUrls();
    const output = job.output;
    download.hidden = !output;
    remove.hidden = !output;
    preview.hidden = true;
    previewImage.removeAttribute('src');
    if (!output) {
      download.removeAttribute('href');
      field('Summary').textContent = '';
      return;
    }

    const { result, options, name } = output;
    outputUrl = URL.createObjectURL(result.blob);
    download.href = outputUrl;
    download.download = name;
    download.textContent = '下載 ' + name;
    const notes = [`加入文字層 ${result.addedPages} 頁，沿用既有文字層 ${result.existingPages} 頁。`];
    if (result.filteredMatches) notes.push(`排除浮水印文字 ${result.filteredMatches} 處。`);
    else if (options.watermarkText.trim()) notes.push('未比對到輸入的浮水印字樣。');
    if (options.hideWatermarkLayers) notes.push(`OCR 暫時隱藏 ${result.hiddenLayers} 個標為浮水印的圖層。`);
    if (result.imageCopy) notes.push(`已將受保護的 PDF 另存為 ${result.rebuiltPages} 頁的未加密影像副本。`);
    else if (result.rebuiltPages) notes.push(`以原頁影像重建 ${result.rebuiltPages} 頁。`);
    if (result.preview) {
      previewUrl = URL.createObjectURL(result.preview.image);
      previewImage.src = previewUrl;
      field('PreviewTitle').textContent = `預覽第 ${result.preview.page} 頁的過濾結果`;
      field('PreviewRemoved').textContent = result.preview.removed.join('、');
      field('PreviewText').textContent = result.preview.text || '這頁未保留可嵌入的文字。';
      preview.hidden = false;
    }
    if (result.emptyPages.length) notes.push(`未取得可嵌入文字的頁面：${result.emptyPages.join('、')}。`);
    if (result.missing.length) notes.push(`字型缺少 ${result.missing.length} 個辨識出的字元（如 ${result.missing.slice(0, 12).join('、')}），請對照原頁。`);
    field('Summary').textContent = notes.join(' ');
  }

  function render() {
    const busy = Boolean(job.controller);
    const locked = job.loading || busy || Boolean(job.pending);
    for (const control of [fileInput, language, watermarks, hideLayers, imageCopy, start]) {
      control.disabled = locked;
    }
    cancel.hidden = !busy;
    resume.hidden = discard.hidden = busy || !job.pending;
    remove.disabled = busy;
    pendingLabel.textContent = job.pending ? job.pending.file.name : '';
    status.textContent = job.loading ? '正在讀取儲存的工作…' : job.message;
    showOutput();
  }

  cancel.addEventListener('click', () => job.controller?.abort());
  resume.addEventListener('click', () => runJob());
  discard.addEventListener('click', () => discardJob());
  remove.addEventListener('click', () => deleteOutput());
  form.addEventListener('submit', event => {
    event.preventDefault();
    const file = fileInput.files?.[0];
    if (!file) return;
    runJob(file, {
      language: language.value,
      watermarkText: watermarks.value,
      hideWatermarkLayers: hideLayers.checked,
      allowImageCopy: imageCopy.checked,
    });
  });

  changes.addEventListener('change', render);
  render();
  void restoreJob();
  return {
    teardown() {
      changes.removeEventListener('change', render);
      releaseUrls();
    },
  };
}
