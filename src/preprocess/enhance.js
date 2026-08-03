/* 送 OCR 前的影像整理：去陰影與對比正規化。
 *
 * 手持拍書常見的問題是一側暗、書脊附近有陰影，Vision 在那些區域會漏字。
 * 作法是「除以背景」：把影像大幅模糊得到光照分布的估計，
 * 再用原圖除以它，光照不均就被抵消掉，紙面回到接近純白。
 *
 * 注意：這個結果只給 OCR 用。貼回 PDF 的插圖一律用未處理的彩色影像，
 * 否則圖片會被洗掉層次。
 */

const OCR_MAX_EDGE = 2400;   // Vision 對密集文字吃得動的解析度，再高只是浪費頻寬

/**
 * 去除不均勻光照。
 * @param {HTMLCanvasElement|ImageBitmap} source
 * @param {{strength?: number}} opts strength 0..1，0 等於不處理
 * @returns {HTMLCanvasElement}
 */
export function removeShadow(source, { strength = 1 } = {}) {
  const w = source.width, h = source.height;

  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const octx = out.getContext('2d', { willReadFrequently: true });
  octx.drawImage(source, 0, 0);
  if (strength <= 0) return out;

  // 背景估計：縮到 1/8 再重度模糊，等效於在原尺寸上做一個超大核，但快得多
  const sw = Math.max(1, Math.round(w / 8));
  const sh = Math.max(1, Math.round(h / 8));
  const small = document.createElement('canvas');
  small.width = sw; small.height = sh;
  const sctx = small.getContext('2d');
  sctx.filter = `blur(${Math.max(2, Math.round(Math.min(sw, sh) / 12))}px)`;
  sctx.drawImage(source, 0, 0, sw, sh);

  // 放大回原尺寸，瀏覽器的雙線性內插剛好給我們平滑的光照場
  const bg = document.createElement('canvas');
  bg.width = w; bg.height = h;
  const bctx = bg.getContext('2d', { willReadFrequently: true });
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(small, 0, 0, w, h);

  // 分條處理，避免一次配置兩張全尺寸 ImageData（4000×3000 就要 96MB）
  const STRIP = 512;
  for (let y = 0; y < h; y += STRIP) {
    const rows = Math.min(STRIP, h - y);
    const src = octx.getImageData(0, y, w, rows);
    const back = bctx.getImageData(0, y, w, rows);
    const a = src.data, b = back.data;

    for (let i = 0; i < a.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const bgv = b[i + c] || 1;
        const norm = (a[i + c] / bgv) * 255;
        // strength 讓使用者可以留一點原始層次，全開時紙面最乾淨
        a[i + c] = clamp(a[i + c] + (norm - a[i + c]) * strength);
      }
    }
    octx.putImageData(src, 0, y);
  }
  return out;
}

const clamp = (v) => v < 0 ? 0 : v > 255 ? 255 : v | 0;

/**
 * 依長邊上限等比縮放。回傳 canvas；已經夠小就原樣畫過去。
 * @param {CanvasImageSource & {width:number,height:number}} source
 */
export function fitTo(source, maxEdge = OCR_MAX_EDGE) {
  const w = source.width, h = source.height;
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, c.width, c.height);
  return c;
}

/** 準備一張要送 Vision 的影像：縮到上限 → 去陰影 → JPEG。 */
export async function forOcr(source, { shadow = 1, quality = 0.88 } = {}) {
  const sized = fitTo(source);
  const clean = shadow > 0 ? removeShadow(sized, { strength: shadow }) : sized;
  return toBlob(clean, 'image/jpeg', quality);
}

export function toBlob(canvas, type = 'image/jpeg', quality = 0.9) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => b ? resolve(b) : reject(new Error('影像編碼失敗')),
      type, quality);
  });
}

export async function blobToBitmap(blob) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(blob); } catch { /* 交給下面的備援 */ }
  }
  // Safari 舊版對某些 HEIC 轉出來的 blob 會失敗，退回 <img>
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('無法解碼影像，可能是不支援的格式'));
      img.src = url;
    });
    return img;
  } finally {
    // 已經 decode 進記憶體了，url 可以放掉
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/** blob → base64（不含 data: 前綴），Vision 的 image.content 要這個格式。 */
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1]);
    fr.onerror = () => reject(fr.error || new Error('讀取影像失敗'));
    fr.readAsDataURL(blob);
  });
}
