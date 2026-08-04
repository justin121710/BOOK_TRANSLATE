/* 圖片區域偵測。
 *
 * Vision 只回傳文字與文字座標，「哪裡有圖」得自己從「非文字區域」反推，
 * 而這必然是啟發式，一定會誤判：大片留白會被當成圖、跨過圖片的文字
 * 會把圖切成碎塊。所以這裡只產生「候選」，最後一定要讓使用者手動增刪
 * （見 SPEC.md 衝突 3）。
 *
 * 作法：把文字框塗掉當遮罩 → 剩下的區域算邊緣密度 → 連通元件 → 面積與形狀過濾。
 */

const GRID = 96;          // 分析網格的長邊格數，格子太細會把一張圖切碎
const EDGE_THRESHOLD = 18; // 相鄰格亮度差多少才算有內容
const MIN_AREA_RATIO = 0.008;  // 小於整頁 0.8% 的候選多半是雜訊
const MIN_SIDE_RATIO = 0.04;   // 太細長的多半是線條或殘留文字

/**
 * @param {CanvasImageSource & {width:number,height:number}} image 校正後的頁面影像
 * @param {object[]} blocks 已辨識的文字塊（用來排除文字區）
 * @returns {{x:number,y:number,w:number,h:number,score:number}[]} 頁面像素座標
 */
export function detectFigures(image, blocks) {
  const W = image.width, H = image.height;
  const cols = W >= H ? GRID : Math.max(8, Math.round(GRID * W / H));
  const rows = W >= H ? Math.max(8, Math.round(GRID * H / W)) : GRID;

  const cellW = W / cols, cellH = H / rows;

  // 縮到網格尺寸取樣。瀏覽器的降採樣本身就是一次低通濾波，正好去掉紙張紋理
  const small = document.createElement('canvas');
  small.width = cols; small.height = rows;
  const sctx = small.getContext('2d', { willReadFrequently: true });
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(image, 0, 0, cols, rows);
  const data = sctx.getImageData(0, 0, cols, rows).data;

  const lum = new Float32Array(cols * rows);
  for (let i = 0; i < cols * rows; i++) {
    lum[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }

  // 文字遮罩：文字塊覆蓋到的格子直接排除
  const isText = new Uint8Array(cols * rows);
  for (const b of blocks || []) {
    const [bx, by, bw, bh] = b.bbox;
    // 往外放一點，文字周圍的殘影才不會被當成圖
    const pad = Math.max(cellW, cellH) * 0.6;
    const x0 = Math.max(0, Math.floor((bx - pad) / cellW));
    const x1 = Math.min(cols - 1, Math.ceil((bx + bw + pad) / cellW));
    const y0 = Math.max(0, Math.floor((by - pad) / cellH));
    const y1 = Math.min(rows - 1, Math.ceil((by + bh + pad) / cellH));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) isText[y * cols + x] = 1;
    }
  }

  // 有內容 = 邊緣強度夠高。純白紙面梯度接近 0，插圖與網點都會被抓到
  const active = new Uint8Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      if (isText[i]) continue;
      const c = lum[i];
      let g = 0;
      if (x > 0)        g = Math.max(g, Math.abs(c - lum[i - 1]));
      if (x < cols - 1) g = Math.max(g, Math.abs(c - lum[i + 1]));
      if (y > 0)        g = Math.max(g, Math.abs(c - lum[i - cols]));
      if (y < rows - 1) g = Math.max(g, Math.abs(c - lum[i + cols]));
      if (g >= EDGE_THRESHOLD) active[i] = 1;
    }
  }

  // 形態學閉運算：把同一張圖裡被斷開的部分接回來
  dilate(active, cols, rows);
  dilate(active, cols, rows);
  erode(active, cols, rows);

  // 連通元件
  const seen = new Uint8Array(cols * rows);
  const out = [];

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const start = y * cols + x;
      if (!active[start] || seen[start]) continue;

      let minX = x, maxX = x, minY = y, maxY = y, count = 0;
      const stack = [start];
      seen[start] = 1;

      while (stack.length) {
        const i = stack.pop();
        const cx = i % cols, cy = (i / cols) | 0;
        count++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const j = ny * cols + nx;
          if (active[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
        }
      }

      const bw = (maxX - minX + 1) * cellW;
      const bh = (maxY - minY + 1) * cellH;
      const areaRatio = (bw * bh) / (W * H);
      const fill = count / ((maxX - minX + 1) * (maxY - minY + 1));

      if (areaRatio < MIN_AREA_RATIO) continue;
      if (bw < W * MIN_SIDE_RATIO || bh < H * MIN_SIDE_RATIO) continue;
      if (fill < 0.25) continue;   // 稀疏的散點多半是雜訊而不是一張圖

      out.push({
        x: minX * cellW, y: minY * cellH, w: bw, h: bh,
        score: Number(fill.toFixed(2)),
      });
    }
  }

  // 大的排前面，使用者先看到重要的
  return out.sort((a, b) => (b.w * b.h) - (a.w * a.h));
}

function dilate(buf, cols, rows) {
  const src = buf.slice();
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      if (src[i]) continue;
      if ((x > 0 && src[i - 1]) || (x < cols - 1 && src[i + 1]) ||
          (y > 0 && src[i - cols]) || (y < rows - 1 && src[i + cols])) buf[i] = 1;
    }
  }
}

function erode(buf, cols, rows) {
  const src = buf.slice();
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      if (!src[i]) continue;
      const n = (x > 0 ? src[i - 1] : 0) + (x < cols - 1 ? src[i + 1] : 0) +
                (y > 0 ? src[i - cols] : 0) + (y < rows - 1 ? src[i + cols] : 0);
      if (n < 2) buf[i] = 0;
    }
  }
}

/**
 * 取樣一個矩形四周的背景色。
 *
 * 圖內文字要用「蓋掉再重寫」的方式取代，直接塗白在彩色插圖上會留下一塊突兀的白斑。
 * 取文字框外圍一圈的中位色來填，多數情況（對白框、招牌、單色底的標示）會融進背景。
 *
 * @returns {{r:number,g:number,b:number}}
 */
export function sampleBackground(image, rect) {
  const pad = Math.max(3, Math.min(rect.w, rect.h) * 0.18);
  const x0 = Math.max(0, Math.floor(rect.x - pad));
  const y0 = Math.max(0, Math.floor(rect.y - pad));
  const x1 = Math.min(image.width, Math.ceil(rect.x + rect.w + pad));
  const y1 = Math.min(image.height, Math.ceil(rect.y + rect.h + pad));
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);

  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, x0, y0, w, h, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;

  // 只取外圈：內部就是要蓋掉的文字，取進來會把顏色拉暗
  const innerX0 = rect.x - x0, innerY0 = rect.y - y0;
  const innerX1 = innerX0 + rect.w, innerY1 = innerY0 + rect.h;

  const rs = [], gs = [], bs = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= innerX0 && x < innerX1 && y >= innerY0 && y < innerY1) continue;
      const i = (y * w + x) * 4;
      rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
    }
  }
  if (!rs.length) return { r: 255, g: 255, b: 255 };

  // 用中位數而不是平均：外圈難免掃到一點文字或邊框，平均會被拉偏
  const mid = (arr) => {
    arr.sort((a, b) => a - b);
    return arr[arr.length >> 1];
  };
  return { r: mid(rs), g: mid(gs), b: mid(bs) };
}

/** 依背景亮度挑一個看得清楚的文字顏色。 */
export function inkFor({ r, g, b }) {
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.55 ? { r: 0.1, g: 0.1, b: 0.1 } : { r: 0.97, g: 0.97, b: 0.97 };
}

/** 從頁面影像裁下一塊，回傳 canvas。用於把插圖與不翻譯的頁眉頁碼貼回 PDF。 */
export function crop(image, rect) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(rect.w));
  c.height = Math.max(1, Math.round(rect.h));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, rect.x, rect.y, rect.w, rect.h, 0, 0, c.width, c.height);
  return c;
}
