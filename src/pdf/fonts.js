/* 字型下載、快取、子集化。
 *
 * 這條路線是實測出來的，不要憑印象改（驗證頁在 _scratch/fonttest.html）：
 *
 *   pdf-lib 的 embedFont(bytes, {subset:true}) 對 CJK 字型是壞的 ——
 *   產出的字型 pdf.js 會直接拒收（Invalid font data in ArrayBuffer），
 *   CFF/OTF 會大量掉漢字，可變 TTF 則整個不渲染。
 *
 * 可行的組合只有一種：
 *   可變 TTF  →  harfbuzz 子集化（同時把可變軸定格成靜態實例）
 *              →  pdf-lib embedFont(subset:false)
 *
 * 所以：字型一律用 google/fonts 的可變 TTF，子集化一律交給 harfbuzz，
 * 而且絕對不要再讓 pdf-lib 自己去 subset。
 */

import * as db from '../state/db.js';

const HB_WASM = 'https://cdn.jsdelivr.net/npm/harfbuzzjs@0.4.7/hb-subset.wasm';

export const FONTS = {
  serif: {
    id: 'serif',
    label: '思源宋體 Noto Serif TC',
    role: '內文',
    url: 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/notoseriftc/NotoSerifTC%5Bwght%5D.ttf',
    wireBytes: 10_140_000,      // 壓縮傳輸的量，這是使用者實際要下載的
    approxBytes: 16_850_000,    // 解壓後的量，進度分母用這個
  },
  sans: {
    id: 'sans',
    label: '思源黑體 Noto Sans TC',
    role: '標題',
    url: 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/notosanstc/NotoSansTC%5Bwght%5D.ttf',
    wireBytes: 7_030_000,
    approxBytes: 11_700_000,
  },
};

/* ---------- 下載與快取 ---------- */

/** 取得字型原始位元組；已快取就直接回傳，否則下載並寫入 IndexedDB。 */
export async function loadFont(id, onProgress) {
  const spec = FONTS[id];
  if (!spec) throw new Error(`未知的字型代號 ${id}`);

  const cached = await db.get('fonts', id);
  if (cached?.bytes) return new Uint8Array(cached.bytes);

  const bytes = await fetchWithProgress(spec.url, spec.approxBytes, onProgress);

  await db.put('fonts', {
    id,
    bytes: bytes.buffer,
    label: spec.label,
    byteLength: bytes.byteLength,
    fetchedAt: Date.now(),
  });
  return bytes;
}

async function fetchWithProgress(url, approxTotal, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`字型下載失敗 HTTP ${res.status}`);

  /* CDN 是壓縮傳輸的：content-length 是壓縮後的位元組（約 9.7MB），
     但 reader 讀到的是解壓後的（約 16MB）。拿兩者相除進度會直接爆到 160%。
     解壓後的大小事先不知道，所以用 approxBytes 當分母，並且夾在 1 以內。 */
  const total = approxTotal;

  // 沒有串流就整包吞下去，行動網路上使用者會等比較久但仍會成功
  if (!res.body?.getReader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress?.(1, buf.byteLength, buf.byteLength);
    return buf;
  }

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.(Math.min(received / total, 1), received, total);
  }

  const out = new Uint8Array(received);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

export async function fontStatus() {
  const rows = await db.getAll('fonts');
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));
  return Object.values(FONTS).map(f => ({
    ...f,
    cached: Boolean(byId[f.id]),
    byteLength: byId[f.id]?.byteLength ?? 0,
  }));
}

export const dropFont = (id) => db.del('fonts', id);

/* ---------- harfbuzz 子集化 ---------- */

let hbp = null;

function harfbuzz() {
  if (!hbp) {
    hbp = WebAssembly.instantiateStreaming(fetch(HB_WASM), {})
      .catch(async () => {
        // 有些主機不給 application/wasm 的 MIME type，instantiateStreaming 會拒絕
        const buf = await (await fetch(HB_WASM)).arrayBuffer();
        return WebAssembly.instantiate(buf, {});
      })
      .then(r => r.instance.exports);
  }
  return hbp;
}

/**
 * 把字型瘦成只含指定字元。
 * @param {Uint8Array} fontBytes 可變 TTF 的原始位元組
 * @param {Iterable<string>} chars 要保留的字元（重複無所謂）
 * @returns {Promise<Uint8Array>} 子集後的靜態 TTF
 */
export async function subsetFont(fontBytes, chars) {
  const ex = await harfbuzz();

  const codepoints = new Set();
  for (const s of chars) for (const ch of String(s)) codepoints.add(ch.codePointAt(0));
  // 這些一定要留：.notdef 以外，空白與換行在排版時會被查詢寬度
  for (const ch of ' 　') codepoints.add(ch.codePointAt(0));

  const ptr = ex.malloc(fontBytes.byteLength);
  // malloc 可能讓 wasm memory 長大，heap view 一定要在 malloc 之後才取
  new Uint8Array(ex.memory.buffer).set(fontBytes, ptr);

  const blob = ex.hb_blob_create(ptr, fontBytes.byteLength, 2 /* WRITABLE */, 0, 0);
  const face = ex.hb_face_create(blob, 0);
  ex.hb_blob_destroy(blob);

  const input = ex.hb_subset_input_create_or_fail();
  if (!input) {
    ex.hb_face_destroy(face); ex.free(ptr);
    throw new Error('harfbuzz 無法建立 subset input');
  }

  const uset = ex.hb_subset_input_unicode_set(input);
  for (const cp of codepoints) ex.hb_set_add(uset, cp);

  // 關鍵：把可變字型的所有軸定格成預設值，變成一般靜態字型。
  // 少了這步，pdf-lib 嵌進去的字型在 pdf.js 會直接無效。
  ex.hb_subset_input_pin_all_axes_to_default(input, face);

  const sub = ex.hb_subset_or_fail(face, input);
  ex.hb_subset_input_destroy(input);
  if (!sub) {
    ex.hb_face_destroy(face); ex.free(ptr);
    throw new Error('harfbuzz 子集化失敗，字型檔可能損毀');
  }

  const rb = ex.hb_face_reference_blob(sub);
  const off = ex.hb_blob_get_data(rb, 0);
  const len = ex.hb_blob_get_length(rb);
  // slice 會複製一份出來，之後釋放 wasm 記憶體才不會把資料一起帶走
  const out = new Uint8Array(ex.memory.buffer).slice(off, off + len);

  ex.hb_blob_destroy(rb);
  ex.hb_face_destroy(sub);
  ex.hb_face_destroy(face);
  ex.free(ptr);

  if (len === 0) throw new Error('harfbuzz 產出空的字型');
  return out;
}

/* ---------- 字符覆蓋檢查 ---------- */

/* Noto Serif/Sans TC 涵蓋全部繁中漢字與日文假名，但缺日文新字體漢字
   （實測缺：静桜峠渋変読対応帰…）。譯文是繁中所以通常沒事，
   但殘留的日文人名地名會變成豆腐框，要在匯出前抓出來。 */

let coverageCache = new Map();

/** 回傳這批文字裡，指定字型沒有字形的字元。 */
export async function findMissingGlyphs(fontId, text) {
  let covered = coverageCache.get(fontId);
  if (!covered) {
    const bytes = await loadFont(fontId);
    covered = readCmapCoverage(bytes);
    coverageCache.set(fontId, covered);
  }
  const missing = new Set();
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === 0x20 || cp === 0x0a || cp === 0x09) continue;
    if (!covered.has(cp)) missing.add(ch);
  }
  return [...missing];
}

/** 直接讀 TTF 的 cmap 表。只為了查覆蓋率而載入整包 fontkit 太浪費。 */
function readCmapCoverage(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numTables = dv.getUint16(4);

  let cmapOff = 0;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const tag = String.fromCharCode(
      bytes[rec], bytes[rec + 1], bytes[rec + 2], bytes[rec + 3]);
    if (tag === 'cmap') { cmapOff = dv.getUint32(rec + 8); break; }
  }
  if (!cmapOff) return new Set();

  // 找 format 4 或 format 12 的子表，優先 12（含 BMP 以外的字）
  const nSub = dv.getUint16(cmapOff + 2);
  let best = 0, bestFormat = -1;
  for (let i = 0; i < nSub; i++) {
    const off = cmapOff + dv.getUint32(cmapOff + 4 + i * 8 + 4);
    const format = dv.getUint16(off);
    if (format === 12) { best = off; bestFormat = 12; break; }
    if (format === 4 && bestFormat < 4) { best = off; bestFormat = 4; }
  }
  if (!best) return new Set();

  const out = new Set();

  if (bestFormat === 12) {
    const nGroups = dv.getUint32(best + 12);
    for (let g = 0; g < nGroups; g++) {
      const o = best + 16 + g * 12;
      const start = dv.getUint32(o), end = dv.getUint32(o + 4);
      for (let cp = start; cp <= end; cp++) out.add(cp);
    }
    return out;
  }

  // format 4
  const segX2 = dv.getUint16(best + 6);
  const segs = segX2 / 2;
  const endO = best + 14;
  const startO = endO + segX2 + 2;
  const deltaO = startO + segX2;
  const rangeO = deltaO + segX2;

  for (let s = 0; s < segs; s++) {
    const end = dv.getUint16(endO + s * 2);
    const start = dv.getUint16(startO + s * 2);
    if (start === 0xffff) continue;
    const rangeOffset = dv.getUint16(rangeO + s * 2);
    for (let cp = start; cp <= end && cp !== 0xffff; cp++) {
      let gid;
      if (rangeOffset === 0) {
        gid = (cp + dv.getInt16(deltaO + s * 2)) & 0xffff;
      } else {
        const gi = rangeO + s * 2 + rangeOffset + (cp - start) * 2;
        if (gi + 1 >= bytes.byteLength) continue;
        gid = dv.getUint16(gi);
        if (gid) gid = (gid + dv.getInt16(deltaO + s * 2)) & 0xffff;
      }
      if (gid) out.add(cp);
    }
  }
  return out;
}
