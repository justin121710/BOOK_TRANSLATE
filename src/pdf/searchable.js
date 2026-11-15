/* 保留原始 PDF 的頁面內容，透過 PDF 的不可見文字模式加上 OCR。 */
import {
  PDFDocument, TextRenderingMode, beginText, endText, popGraphicsState,
  pushGraphicsState, setFontAndSize, setTextMatrix, setTextRenderingMode, showText,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { annotate } from '../api/vision.js';
import {
  extractItems, NATIVE_TEXT_MIN_CHARS_PER_PAGE, openPdf, RENDER_MAX_EDGE,
} from '../input/pdfin.js';
import { blobToBase64, toBlob } from '../preprocess/enhance.js';
import { findMissingGlyphs, loadFont, subsetFont } from './fonts.js';

const FONT_BY_LANGUAGE = { 'zh-Hant': 'sans', 'zh-Hans': 'ocrSC', ja: 'ocrJP', en: 'sans' };

export async function makeSearchablePdf(file, { language, signal, onProgress } = {}) {
  const fontId = FONT_BY_LANGUAGE[language] || 'sans';
  const reader = await openPdf(file);
  try {
    signal?.throwIfAborted();
    const pdf = await PDFDocument.load(await file.arrayBuffer(), { updateMetadata: false });
    const pages = pdf.getPages();
    if (pages.length !== reader.numPages) throw new Error('無法比對原始 PDF 頁數');

    const overlays = [];
    const emptyPages = [];
    const chars = new Set();
    let existingPages = 0;
    for (let n = 1; n <= reader.numPages; n++) {
      signal?.throwIfAborted();
      onProgress?.(n, reader.numPages);
      const page = await reader.getPage(n);
      try {
        const text = await page.getTextContent();
        const count = text.items.reduce((sum, item) =>
          sum + (item.str?.match(/[\p{L}\p{N}]/gu)?.length ?? 0), 0);
        if (count >= NATIVE_TEXT_MIN_CHARS_PER_PAGE) {
          existingPages++;
          continue;
        }

        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({
          scale: Math.min(3, RENDER_MAX_EDGE / Math.max(base.width, base.height)),
        });
        const nativeBoxes = extractItems(text, viewport)
          .filter(item => /[\p{L}\p{N}]/u.test(item.str)).map(item => item.bbox);
        const words = await recognise(page, viewport, nativeBoxes, language, signal);
        if (!words.length) {
          if (count) existingPages++;
          else emptyPages.push(n);
          continue;
        }
        overlays.push({ page: pages[n - 1], number: n, words });
        for (const { text: word } of words) for (const ch of word) chars.add(ch);
      } catch (error) {
        signal?.throwIfAborted();
        throw new Error(`第 ${n} 頁：${error.message}`, { cause: error });
      } finally {
        page.cleanup();
      }
    }

    signal?.throwIfAborted();
    if (!overlays.length) return { blob: file, existingPages, emptyPages, addedPages: 0, missing: [] };

    onProgress?.();
    const missing = await findMissingGlyphs(fontId, [...chars].join(''));
    const unsupported = new Set(missing);
    pdf.registerFontkit(fontkit);
    const fontBytes = await subsetFont(await loadFont(fontId), chars);
    const font = await pdf.embedFont(fontBytes, { subset: false });
    let addedPages = 0;
    for (const { page, number, words } of overlays) {
      signal?.throwIfAborted();
      if (writeWords(page, words, font, unsupported)) addedPages++;
      else emptyPages.push(number);
    }

    const bytes = await pdf.save({ updateFieldAppearances: false });
    signal?.throwIfAborted();
    const blob = new Blob([bytes], { type: 'application/pdf' });
    return { blob, addedPages, existingPages, emptyPages: emptyPages.sort((a, b) => a - b), missing };
  } finally {
    await reader.destroy();
  }
}

async function recognise(page, viewport, nativeBoxes, language, signal) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  let content;
  try {
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    signal?.throwIfAborted();
    content = await blobToBase64(await toBlob(canvas, 'image/jpeg', 0.92));
  } finally {
    canvas.width = canvas.height = 0;
  }
  signal?.throwIfAborted();
  const [result] = await annotate([{
    image: { content },
    features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
    ...(language ? { imageContext: { languageHints: [language] } } : {}),
  }], { signal });

  const words = [];
  for (const ocrPage of result?.fullTextAnnotation?.pages ?? []) {
    for (const block of ocrPage.blocks ?? []) {
      for (const paragraph of block.paragraphs ?? []) {
        for (const word of paragraph.words ?? []) {
          const positioned = locateWord(word, viewport, nativeBoxes);
          if (positioned) words.push(positioned);
        }
      }
    }
  }
  return words;
}

function locateWord(word, viewport, nativeBoxes) {
  const symbols = word.symbols ?? [];
  const text = symbols.map(symbol => symbol.text ?? '').join('').trim();
  const breakType = symbols.at(-1)?.property?.detectedBreak?.type;
  const trailingSpace = breakType === 'SPACE' || breakType === 'SURE_SPACE';
  const vertices = word.boundingBox?.vertices;
  if (!text || vertices?.length !== 4) return null;

  // Vision 的四角依文字自然方向排序；座標在邊界為零時可能省略。
  const corners = vertices.map(({ x = 0, y = 0 }) => [x, y]);
  const centerX = corners.reduce((sum, [x]) => sum + x, 0) / 4;
  const centerY = corners.reduce((sum, [, y]) => sum + y, 0) / 4;
  if (nativeBoxes.some(([x, y, w, h]) =>
    centerX >= x && centerX <= x + w && centerY >= y && centerY <= y + h)) return null;

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
