import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { mergeVolumes } from './merge-volumes.js';
import { blobToBitmap, toBlob } from '../preprocess/enhance.js';

const MB = 1_000_000;
const PDF_TYPE = 'application/pdf';

export function limitBytes(mb) {
  const bytes = Math.floor(Number(mb) * MB);
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error('請輸入有效的 MB 上限');
  return bytes;
}

const pdfBlob = async doc => new Blob([await doc.save({ updateFieldAppearances: false })], { type: PDF_TYPE });

async function reduceJpeg(doc, maxEdge, quality, signal) {
  let changed = false;
  const name = key => PDFName.of(key);
  for (const [ref, image] of doc.context.enumerateIndirectObjects()) {
    signal?.throwIfAborted();
    if (!(image instanceof PDFRawStream)) continue;
    const { dict } = image;
    if (dict.get(name('Subtype'))?.toString() !== '/Image' ||
        dict.get(name('ColorSpace'))?.toString() !== '/DeviceRGB' ||
        dict.get(name('Filter'))?.toString() !== '/DCTDecode' ||
        ['Decode', 'DecodeParms', 'SMask', 'Mask', 'ImageMask', 'Alternates'].some(key => dict.has(name(key)))) continue;
    const data = image.getContents();
    if (data.length < 24_000) continue;
    let bitmap;
    let canvas;
    try {
      bitmap = await blobToBitmap(new Blob([data], { type: 'image/jpeg' }));
      if (bitmap.width !== dict.get(name('Width'))?.asNumber?.() ||
          bitmap.height !== dict.get(name('Height'))?.asNumber?.()) continue;
      const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
      canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const jpg = await toBlob(canvas, 'image/jpeg', quality);
      if (jpg.size >= data.length) continue;
      const newDict = dict.clone();
      newDict.set(name('Width'), doc.context.obj(canvas.width));
      newDict.set(name('Height'), doc.context.obj(canvas.height));
      doc.context.assign(ref, PDFRawStream.of(newDict, new Uint8Array(await jpg.arrayBuffer())));
      changed = true;
    } catch (error) {
      signal?.throwIfAborted();
      // 無法在瀏覽器安全解碼的影像由原 PDF 直接保留。
    } finally {
      bitmap?.close?.();
      if (canvas) canvas.width = canvas.height = 0;
    }
  }
  return changed;
}

export async function fitPdfToLimit(volumes, mb, { signal, onProgress } = {}) {
  const cap = limitBytes(mb);
  const totalBytes = volumes.reduce((sum, volume) => sum + volume.blob.size, 0);
  if (volumes.length === 1 && totalBytes <= cap) return volumes;
  let offset = 0;
  const pieces = [];
  const maxEdge = Math.round(Math.max(1300, Math.min(2000, 2000 * Math.sqrt(cap / totalBytes))));

  for (const [index, volume] of volumes.entries()) {
    onProgress?.(index + 1, volumes.length);
    signal?.throwIfAborted();
    let doc;
    try {
      doc = await PDFDocument.load(await volume.blob.arrayBuffer(), { updateMetadata: false });
    } catch (error) {
      if (!error?.message?.includes('is encrypted')) throw error;
      throw new Error('原檔受保護。請先加上文字層，再對產出的副本調整大小');
    }
    const count = doc.getPageCount();
    const reduced = await reduceJpeg(doc, maxEdge, 0.76, signal);
    const rendered = reduced ? await pdfBlob(doc) : volume.blob;
    const compact = rendered.size < volume.blob.size ? rendered : volume.blob;
    const source = compact === rendered ? doc : await PDFDocument.load(await compact.arrayBuffer(), { updateMetadata: false });
    await split(source, compact, 0, count);
    offset += count;
  }
  signal?.throwIfAborted();
  if (pieces.length <= 1) return pieces;
  if (pieces.reduce((sum, part) => sum + part.blob.size, 0) <= cap) {
    const merged = await mergeVolumes(pieces.map(part => ({
      range: { from: part.from, to: part.to, total: offset }, result: { blob: part.blob },
    })), { signal });
    if (merged.size <= cap) return [{ blob: merged, from: 1, to: offset }];
  }
  return pieces;

  async function split(source, blob, from, to) {
    signal?.throwIfAborted();
    if (blob.size <= cap) {
      pieces.push({ blob, from: offset + from + 1, to: offset + to });
      return;
    }
    if (to - from === 1) {
      throw new Error(`第 ${offset + from + 1} 頁單獨仍超過 ${mb} MB，請提高上限`);
    }
    const mid = from + Math.ceil((to - from) / 2);
    for (const [start, end] of [[from, mid], [mid, to]]) {
      const part = await PDFDocument.create();
      const indexes = Array.from({ length: end - start }, (_, i) => start + i);
      for (const page of await part.copyPages(source, indexes)) part.addPage(page);
      await split(source, await pdfBlob(part), start, end);
    }
  }
}
