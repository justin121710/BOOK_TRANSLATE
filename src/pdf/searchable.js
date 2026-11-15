/* 保留頁面外觀，以 PDF 的不可見文字模式加入可擷取文字。 */
import {
  PDFDocument, PDFName, TextRenderingMode, beginText, degrees, endText, popGraphicsState,
  pushGraphicsState, setFontAndSize, setTextMatrix, setTextRenderingMode, showText,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { AnnotationMode } from 'pdfjs-dist/build/pdf.min.mjs';
import { annotate } from '../api/vision.js';
import {
  extractItems, NATIVE_TEXT_MIN_CHARS_PER_PAGE, openPdf, RENDER_MAX_EDGE,
} from '../input/pdfin.js';
import { blobToBase64, toBlob } from '../preprocess/enhance.js';
import { findMissingGlyphs, loadFont, subsetFont } from './fonts.js';
import { excludeWatermarks, isWatermarkLayer, sliceWord, watermarkPatterns } from './watermark.js';

// Vision images:annotate 接受最多 16 張圖及 10 MB JSON。留出大小餘裕。
const OCR_BATCH_PAGES = 16;
const OCR_BATCH_BYTES = 9_000_000;

const FONT_BY_LANGUAGE = { 'zh-Hant': 'sans', 'zh-Hans': 'ocrSC', ja: 'ocrJP', en: 'sans' };

export async function makeSearchablePdf(file, {
  language, watermarkText = '', hideWatermarkLayers = false, allowImageCopy = false,
  signal, onProgress, checkpoint, from = 1, splitLarge = false,
} = {}) {
  const patterns = watermarkPatterns(watermarkText);
  const fontId = FONT_BY_LANGUAGE[language] || 'sans';
  const reader = await openPdf(file);
  let readerClosed = false;
  let inFlight;
  const network = new AbortController();
  const cancelNetwork = () => network.abort();
  signal?.addEventListener('abort', cancelNetwork, { once: true });
  try {
    signal?.throwIfAborted();
    const total = reader.numPages;
    // 長文件及大型影像 PDF 分冊，限制單次寫出的頁面數及估算大小。
    const maxBytes = 24 * 1024 * 1024;
    const partSize = splitLarge && (total > 96 || file.size > 2 * maxBytes)
      ? Math.max(1, Math.min(48, Math.floor(maxBytes * total / file.size))) : total;
    const to = Math.min(total, from + partSize - 1);
    const partial = from > 1 || to < total;
    const range = { from, to, total };
    let pdf;
    let imageCopy = false;
    try {
      pdf = await PDFDocument.load(await file.arrayBuffer(), { updateMetadata: false });
    } catch (error) {
      signal?.throwIfAborted();
      // pdf-lib 1.17.1 的加密錯誤會以一般 Error 拋出。
      if (!error?.message?.startsWith('Input document to `PDFDocument.load` is encrypted.')) throw error;
      if (!allowImageCopy) {
        throw new Error('這份 PDF 可以開啟，但無法直接改寫。若要另存可搜尋副本，請勾選「受保護的 PDF 另存為影像副本」');
      }
      pdf = await PDFDocument.create();
      imageCopy = true;
    }
    if (!imageCopy && pdf.getPageCount() !== total) throw new Error('無法比對原始 PDF 頁數');
    if (!imageCopy && partial) {
      const part = await PDFDocument.create();
      const indexes = Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i);
      for (const page of await part.copyPages(pdf, indexes)) part.addPage(page);
      pdf = part;
    }
    const pages = pdf.getPages();

    const layerConfig = hideWatermarkLayers ? await reader.getOptionalContentConfig() : null;
    let hiddenLayers = 0;
    for (const [id, group] of Object.entries(layerConfig?.getGroups() ?? {})) {
      if (group.visible && isWatermarkLayer(group.name)) {
        layerConfig.setVisibility(id, false);
        hiddenLayers++;
      }
    }

    const overlays = [];
    const emptyPages = [];
    const chars = new Set();
    let existingPages = 0;
    let rebuiltPages = 0;
    let filteredMatches = 0;
    let preview;
    const requestOptions = {
      features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
      ...(language ? { imageContext: { languageHints: [language] } } : {}),
    };
    // Base64 的字元在 JSON 中不需跳脫，每字元一個位元組。
    const requestOverhead = new TextEncoder().encode(JSON.stringify({
      image: { content: '' }, ...requestOptions,
    })).length + 1;
    let batch = [];
    let batchBytes = 0;
    let batchesSinceCleanup = 0;

    async function recogniseAndSave(items) {
      const requests = items.filter(item => item.request);
      await recogniseBatch(requests, total, onProgress, network.signal);
      const recognised = requests.map(item => {
        item.ocr = readRecognition(item.response, item.viewport, item.nativeBoxes, patterns);
        delete item.response;
        delete item.request;
        return { number: item.n, ocr: item.ocr };
      });
      if (recognised.length) await checkpoint?.save(recognised);
    }

    async function finishBatch() {
      if (!inFlight) return;
      const { items, done } = inFlight;
      const outcome = await done;
      if (outcome) throw outcome.error;
      for (const item of items) await finishPage(item);
      inFlight = null;
      if (++batchesSinceCleanup === 4) {
        await reader.cleanup();
        batchesSinceCleanup = 0;
      }
    }

    async function flushBatch() {
      if (!batch.length) return;
      await finishBatch();
      // 準備下一批頁面時，前一批可同時上傳和辨識，只保留兩批影像。
      const items = batch;
      inFlight = { items, done: recogniseAndSave(items).catch(error => ({ error })) };
      batch = [];
      batchBytes = 0;
    }

    for (let n = from; n <= to; n++) {
      signal?.throwIfAborted();
      onProgress?.(n, reader.numPages);
      const page = await reader.getPage(n);
      let item;
      let bytes = 0;
      try {
        const text = await page.getTextContent();
        const nativeItems = text.items.filter(item => item.str);
        const native = excludeWatermarks(nativeItems.map(item => item.str), patterns);
        const rebuild = imageCopy || native.matches.length > 0;
        const count = nativeItems.reduce((sum, item, i) => sum + native.runs[i].reduce(
          (total, { start, end }) => total +
            (item.str.slice(start, end).match(/[\p{L}\p{N}]/gu)?.length ?? 0), 0), 0);
        if (!rebuild && count >= NATIVE_TEXT_MIN_CHARS_PER_PAGE) {
          existingPages++;
          page.cleanup();
          continue;
        }

        const viewport = pageViewport(page);
        const nativeWords = rebuild ? nativeItems.flatMap((item, i) => {
          const word = locateNative(item);
          return word ? native.runs[i].map(run => sliceWord(word, run)).filter(Boolean) : [];
        }) : [];
        const nativeBoxes = rebuild
          ? nativeWords.map(word => wordBox(word, viewport))
          : extractItems(text, viewport).filter(item => /[\p{L}\p{N}]/u.test(item.str)).map(item => item.bbox);
        let request;
        let copyImage;
        const ocr = count < NATIVE_TEXT_MIN_CHARS_PER_PAGE ? await checkpoint?.load(n) : undefined;
        if (count < NATIVE_TEXT_MIN_CHARS_PER_PAGE && !ocr) {
          const image = await renderPage(page, viewport, {
            type: 'image/jpeg', layerConfig: hiddenLayers ? layerConfig : null, signal,
          });
          signal?.throwIfAborted();
          const content = await blobToBase64(image);
          signal?.throwIfAborted();
          request = { image: { content }, ...requestOptions };
          bytes = content.length + requestOverhead;
          if (bytes > OCR_BATCH_BYTES) throw new Error('OCR 影像太大，無法送出');
          if (imageCopy && !page.rotate && !hiddenLayers) copyImage = image;
        }
        item = { n, page, viewport, nativeBoxes, nativeWords, native, count, rebuild, request, copyImage, ocr };
        page.cleanup();
      } catch (error) {
        signal?.throwIfAborted();
        page.cleanup();
        throw new Error(`第 ${n} 頁：${error.message}`, { cause: error });
      }
      if (batchBytes + bytes > OCR_BATCH_BYTES) await flushBatch();
      batch.push(item);
      batchBytes += bytes;
      if (batch.length === OCR_BATCH_PAGES) await flushBatch();
    }
    await flushBatch();
    await finishBatch();

    async function finishPage({ n, page, nativeWords, native, count, rebuild, copyImage,
      ocr = { words: [], matches: [] } }) {
      try {
        signal?.throwIfAborted();
        const words = [...nativeWords, ...ocr.words];
        const matches = [...native.matches, ...ocr.matches];
        filteredMatches += matches.length;
        if (matches.length && !preview) {
          const image = await renderPage(page, pageViewport(page, 720, 1),
            { type: 'image/jpeg', signal });
          preview = {
            image, page: n, removed: [...new Set(matches)].slice(0, 10),
            text: words.map(word => word.text).join(' ').slice(0, 2400),
          };
        }

        let target = pages[n - from];
        if (imageCopy) {
          target = await copyPageAsImage(pdf, page, signal, copyImage);
        } else if (rebuild) {
          await rebuildPage(pdf, target, page, signal);
        }
        if (rebuild) {
          rebuiltPages++;
        }
        if (!words.length) {
          if (count && !rebuild) existingPages++;
          else emptyPages.push(n);
          return;
        }
        overlays.push({ page: target, number: n, words });
        for (const { text: word } of words) for (const ch of word) chars.add(ch);
      } catch (error) {
        signal?.throwIfAborted();
        throw new Error(`第 ${n} 頁：${error.message}`, { cause: error });
      } finally {
        page.cleanup();
      }
    }

    signal?.throwIfAborted();
    await reader.destroy();
    readerClosed = true;
    const summary = { existingPages, emptyPages, rebuiltPages, filteredMatches, hiddenLayers, preview, imageCopy, range };
    if (!partial && !overlays.length && !rebuiltPages) return { ...summary, blob: file, addedPages: 0, missing: [] };

    onProgress?.();
    const missing = [];
    let addedPages = 0;
    if (overlays.length) {
      missing.push(...await findMissingGlyphs(fontId, [...chars].join('')));
      const unsupported = new Set(missing);
      pdf.registerFontkit(fontkit);
      const fontBytes = await subsetFont(await loadFont(fontId), chars);
      const font = await pdf.embedFont(fontBytes, { subset: false });
      for (const { page, number, words } of overlays) {
        signal?.throwIfAborted();
        if (writeWords(page, words, font, unsupported)) addedPages++;
        else emptyPages.push(number);
        if (number % 8 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    signal?.throwIfAborted();
    const bytes = await pdf.save({ updateFieldAppearances: false, objectsPerTick: 20 });
    signal?.throwIfAborted();
    const blob = new Blob([bytes], { type: 'application/pdf' });
    return { ...summary, blob, addedPages, emptyPages: emptyPages.sort((a, b) => a - b), missing };
  } finally {
    cancelNetwork();
    await inFlight?.done;
    signal?.removeEventListener('abort', cancelNetwork);
    if (!readerClosed) await reader.destroy();
  }
}

function pageViewport(page, maxEdge = RENDER_MAX_EDGE, maxScale = 3, rotation = page.rotate) {
  const base = page.getViewport({ scale: 1, rotation });
  return page.getViewport({
    scale: Math.min(maxScale, maxEdge / Math.max(base.width, base.height)), rotation,
  });
}

async function renderPage(page, viewport, { type, layerConfig, annotationMode, signal }) {
  signal?.throwIfAborted();
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const render = page.render({
    canvasContext: canvas.getContext('2d'),
    viewport,
    annotationMode,
    ...(layerConfig ? { optionalContentConfigPromise: Promise.resolve(layerConfig) } : {}),
    ...(type === 'image/png' ? { background: 'rgba(0,0,0,0)' } : {}),
  });
  const cancel = () => render.cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    await render.promise;
    signal?.throwIfAborted();
    return await toBlob(canvas, type, 0.92);
  } finally {
    signal?.removeEventListener('abort', cancel);
    canvas.width = canvas.height = 0;
  }
}

async function rebuildPage(pdf, target, original, signal) {
  // 保留頁面、注釋與旋轉設定，用原外觀取代含有浮水印文字的內容串流。
  const viewport = pageViewport(original, RENDER_MAX_EDGE, 3, 0);
  const image = await renderPage(original, viewport, { type: 'image/png', annotationMode: AnnotationMode.DISABLE, signal });
  signal?.throwIfAborted();
  const png = await pdf.embedPng(await image.arrayBuffer());
  target.node.set(PDFName.of('Contents'), pdf.context.obj([]));
  // PDFPage 可能已快取自己的新內容串流；這裡每頁只重建一次，且在寫文字前執行。
  drawPageImage(target, png, original, viewport);
}

async function copyPageAsImage(pdf, original, signal, copyImage) {
  const viewport = pageViewport(original, RENDER_MAX_EDGE, 3, 0);
  // 使用原始可見圖層及註記；OCR 專用的浮水印隱藏設定不套用到成品。
  const blob = copyImage ?? await renderPage(original, viewport, { type: 'image/jpeg', signal });
  signal?.throwIfAborted();
  const image = await pdf.embedJpg(await blob.arrayBuffer());
  const [x, y, right, top] = original.view;
  const target = pdf.addPage([right - x, top - y]);
  target.setMediaBox(x, y, right - x, top - y);
  target.setRotation(degrees(original.rotate));
  if (original.userUnit !== 1) {
    target.node.set(PDFName.of('UserUnit'), pdf.context.obj(original.userUnit));
  }
  drawPageImage(target, image, original, viewport);
  return target;
}

function drawPageImage(target, image, original, viewport) {
  const [x, y, right, top] = original.view;
  const height = (top - y) * Math.ceil(viewport.height) / viewport.height;
  target.drawImage(image, {
    x, y: top - height, height,
    width: (right - x) * Math.ceil(viewport.width) / viewport.width,
  });
}

async function recogniseBatch(items, total, onProgress, signal) {
  if (!items.length) return;
  const first = items[0].n;
  const last = items.at(-1).n;
  onProgress?.(first, total, { last, count: items.length });
  let responses;
  try {
    responses = await annotate(items.map(item => item.request), { signal, allowItemErrors: true });
  } catch (error) {
    signal?.throwIfAborted();
    const range = first === last ? first : `${first}–${last}`;
    throw new Error(`第 ${range} 頁批次 OCR：${error.message}`, { cause: error });
  }
  if (!Array.isArray(responses) || responses.length !== items.length) {
    throw new Error(`第 ${first}–${last} 頁批次 OCR：回傳結果筆數與送出的頁數不符`);
  }
  for (const [i, item] of items.entries()) {
    const response = responses[i];
    if (!response || response.error) {
      throw new Error(`第 ${item.n} 頁 OCR：${response?.error?.message || '未收到有效辨識結果'}`);
    }
    item.response = response;
  }
}

function readRecognition(result, viewport, nativeBoxes, patterns) {
  const words = [];
  const matches = [];
  for (const ocrPage of result?.fullTextAnnotation?.pages ?? []) {
    for (const block of ocrPage.blocks ?? []) {
      for (const paragraph of block.paragraphs ?? []) {
        const entries = paragraph.words ?? [];
        const texts = entries.map(word => word.symbols?.map(symbol => symbol.text ?? '').join('') ?? '');
        const filtered = excludeWatermarks(texts, patterns);
        for (const match of filtered.matches) matches.push(match);
        for (const [i, word] of entries.entries()) {
          const positioned = locateWord(word, texts[i], viewport);
          if (!positioned) continue;
          const positions = filtered.matches.length ? symbolPositions(word.symbols, positioned, viewport) : null;
          for (const run of filtered.runs[i]) {
            const piece = sliceWord(positioned, run, positions);
            if (piece && !overlapsNative(piece, viewport, nativeBoxes)) words.push(piece);
          }
        }
      }
    }
  }
  return { words, matches };
}

function locateNative(item) {
  const [a, b, c, d, x, y] = item.transform;
  const vertical = item.dir === 'ttb';
  const advance = vertical ? [-c, -d] : [a, b];
  const up = vertical ? [a, b] : [c, d];
  const length = Math.hypot(...advance);
  const width = vertical ? item.height : item.width;
  if (!length || !width || !Math.hypot(...up)) return null;
  return {
    text: item.str, trailingSpace: item.hasEOL,
    right: advance.map(value => value * width / length),
    up, origin: [x - 0.15 * up[0], y - 0.15 * up[1]],
  };
}

function wordBox({ origin, right, up }, viewport) {
  const corners = [origin, [origin[0] + right[0], origin[1] + right[1]],
    [origin[0] + up[0], origin[1] + up[1]],
    [origin[0] + right[0] + up[0], origin[1] + right[1] + up[1]]]
    .map(([x, y]) => viewport.convertToViewportPoint(x, y));
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return [x, y, Math.max(...xs) - x, Math.max(...ys) - y];
}

function symbolPositions(symbols, { text, origin, right }, viewport) {
  const positions = new Map([[0, 0], [text.length, 1]]);
  const size = right[0] ** 2 + right[1] ** 2;
  let offset = 0;
  for (const symbol of symbols) {
    const vertex = symbol.boundingBox?.vertices?.[3];
    if (offset > 0 && offset < text.length && vertex) {
      const [x, y] = viewport.convertToPdfPoint(vertex.x ?? 0, vertex.y ?? 0);
      const position = ((x - origin[0]) * right[0] + (y - origin[1]) * right[1]) / size;
      positions.set(offset, Math.max(0, Math.min(position, 1)));
    }
    offset += symbol.text?.length ?? 0;
  }
  return positions;
}

function overlapsNative({ origin, right, up }, viewport, boxes) {
  const [cx, cy] = viewport.convertToViewportPoint(
    origin[0] + (right[0] + up[0]) / 2,
    origin[1] + (right[1] + up[1]) / 2,
  );
  return boxes.some(([x, y, w, h]) => cx >= x && cx <= x + w && cy >= y && cy <= y + h);
}

function locateWord(word, text, viewport) {
  const symbols = word.symbols ?? [];
  const breakType = symbols.at(-1)?.property?.detectedBreak?.type;
  const trailingSpace = breakType === 'SPACE' || breakType === 'SURE_SPACE';
  const vertices = word.boundingBox?.vertices;
  if (!text.trim() || vertices?.length !== 4) return null;

  // Vision 的四角依文字自然方向排序；座標在邊界為零時可能省略。
  const corners = vertices.map(({ x = 0, y = 0 }) => [x, y]);
  const [tl, tr, br, bl] = corners.map(([x, y]) => viewport.convertToPdfPoint(x, y));
  const right = [(tr[0] + br[0] - tl[0] - bl[0]) / 2,
                 (tr[1] + br[1] - tl[1] - bl[1]) / 2];
  const up = [(tl[0] - bl[0] + tr[0] - br[0]) / 2,
              (tl[1] - bl[1] + tr[1] - br[1]) / 2];
  if (!Math.hypot(...right) || !Math.hypot(...up)) return null;
  return { text, right, up, origin: bl, trailingSpace };
}

function writeWords(page, words, font, unsupported) {
  const operators = [];
  for (const { text, right, up, origin, trailingSpace } of words) {
    const supported = Array.from(text, ch => unsupported.has(ch) ? ' ' : ch).join('');
    if (!supported.trim()) continue;
    const width = font.widthOfTextAtSize(supported, 1);
    if (!width) continue;
    // 以辨識框的寬高定位選取範圍，並將基線移出下緣。
    operators.push(
      setTextMatrix(right[0] / width, right[1] / width, up[0], up[1],
        origin[0] + 0.15 * up[0], origin[1] + 0.15 * up[1]),
      showText(font.encodeText(supported + (trailingSpace ? ' ' : ''))),
    );
  }
  if (!operators.length) return false;
  const resource = page.node.newFontDictionary(font.name, font.ref);
  page.pushOperators(
    pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible),
    setFontAndSize(resource, 1), ...operators, endText(), popGraphicsState(),
  );
  return true;
}
