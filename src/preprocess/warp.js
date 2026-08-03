/* 透視校正。
 *
 * 手持拍書一定有梯形變形，而 OCR 回傳的是變形後的座標。
 * 直接把那些座標搬進平面 PDF，整頁會歪斜、行距不均 —— 所以校正必須發生在 OCR 之前。
 *
 * 作法是解出 3×3 homography，然後在 WebGL 的片段著色器裡逐像素做反向取樣。
 *
 * 之前用過 canvas2d 的網格法（把畫面切成三角形逐塊仿射貼圖），會在紙面上留下
 * 淡淡的對角線接縫：三角形之間必須外推一點才不會有空隙，而外推造成反鋸齒邊緣
 * 被合成兩次，淺色紙面上就顯出格線。那個瑕疵沒辦法靠調參數消掉，
 * 所以主路徑改走 WebGL，數學上精確且完全沒有接縫。
 * 網格法留著當沒有 WebGL 時的備援。
 */

/**
 * 解出把 from 四點映到 to 四點的 3×3 homography。
 * @param {[number,number][]} from 四個點
 * @param {[number,number][]} to 四個點
 * @returns {number[]} 長度 9 的矩陣，row-major，h[8] 固定為 1
 */
export function homography(from, to) {
  // 每組對應點給兩條方程式，8 個未知數
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i];
    const [u, v] = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solve(A, b);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/** 高斯消去法，含部分主元選擇。n 只有 8，直接寫比引函式庫划算。 */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) throw new Error('四個角退化了，無法解出透視變換');
    [M[col], M[pivot]] = [M[pivot], M[col]];

    const d = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= d;

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (!f) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map(row => row[n]);
}

/** 用 homography 變換一個點。 */
export function project(h, x, y) {
  const w = h[6] * x + h[7] * y + h[8];
  return [
    (h[0] * x + h[1] * y + h[2]) / w,
    (h[3] * x + h[4] * y + h[5]) / w,
  ];
}

/**
 * 依四個角把來源影像拉正成矩形。
 * @param {CanvasImageSource & {width:number,height:number}} img
 * @param {[number,number][]} corners 原圖像素座標，順序為左上、右上、右下、左下
 * @param {{width?:number, height?:number, grid?:number}} opts
 * @returns {HTMLCanvasElement}
 */
export function warp(img, corners, opts = {}) {
  const [tl, tr, br, bl] = corners;

  // 沒指定輸出尺寸就從四邊長度推：取對邊較長者，避免壓縮到內容
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const outW = Math.round(opts.width  ?? Math.max(dist(tl, tr), dist(bl, br)));
  const outH = Math.round(opts.height ?? Math.max(dist(tl, bl), dist(tr, br)));

  // 目的地矩形 → 原圖四角
  const H = homography(
    [[0, 0], [outW, 0], [outW, outH], [0, outH]],
    [tl, tr, br, bl],
  );

  if (!opts.forceMesh) {
    const gl = warpGL(img, H, outW, outH);
    if (gl) return gl;
  }
  return warpMesh(img, H, outW, outH, opts.grid ?? 24);
}

/* ---------- WebGL 路徑（主要） ---------- */

const VERT = `
attribute vec2 a;
void main() { gl_Position = vec4(a, 0.0, 1.0); }`;

/* gl_FragCoord 的原點在左下，來源影像是左上，所以 y 要翻。
   uH 是「目的地像素 → 來源像素」的 homography，除以 uSrc 之後就是紋理座標。 */
const FRAG = `
precision highp float;
uniform sampler2D uTex;
uniform mat3 uH;
uniform vec2 uSrc;
uniform vec2 uDst;
void main() {
  vec2 d = vec2(gl_FragCoord.x, uDst.y - gl_FragCoord.y);
  vec3 p = uH * vec3(d, 1.0);
  vec2 uv = (p.xy / p.z) / uSrc;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);   // 範圍外補白，比黑邊好看
  } else {
    gl_FragColor = texture2D(uTex, uv);
  }
}`;

function warpGL(img, H, outW, outH) {
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;

  const gl = canvas.getContext('webgl', { premultipliedAlpha: false, antialias: false })
          || canvas.getContext('experimental-webgl');
  if (!gl) return null;

  try {
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (img.width > max || img.height > max) return null;

    const prog = buildProgram(gl, VERT, FRAG);
    if (!prog) return null;
    gl.useProgram(prog);

    // 一個蓋滿畫面的三角形，比兩個三角形少一條對角線也少一次頂點處理
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);

    // WebGL 的 mat3 uniform 吃 column-major，而 homography() 產出的是 row-major
    gl.uniformMatrix3fv(gl.getUniformLocation(prog, 'uH'), false, new Float32Array([
      H[0], H[3], H[6],
      H[1], H[4], H[7],
      H[2], H[5], H[8],
    ]));
    gl.uniform2f(gl.getUniformLocation(prog, 'uSrc'), img.width, img.height);
    gl.uniform2f(gl.getUniformLocation(prog, 'uDst'), outW, outH);
    gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);

    gl.viewport(0, 0, outW, outH);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (gl.getError() !== gl.NO_ERROR) return null;

    // 把結果搬到一般的 2D canvas。WebGL canvas 的 backing store 隨時可能被回收，
    // 而這張圖後面還要編碼成 JPEG、裁切貼進 PDF。
    const out = document.createElement('canvas');
    out.width = outW;
    out.height = outH;
    out.getContext('2d').drawImage(canvas, 0, 0);

    gl.deleteTexture(tex);
    gl.deleteBuffer(buf);
    gl.deleteProgram(prog);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return out;
  } catch (e) {
    console.warn('WebGL 透視校正失敗，改用網格法', e);
    return null;
  }
}

function buildProgram(gl, vertSrc, fragSrc) {
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn('shader 編譯失敗', gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  };
  const v = compile(gl.VERTEX_SHADER, vertSrc);
  const f = compile(gl.FRAGMENT_SHADER, fragSrc);
  if (!v || !f) return null;

  const p = gl.createProgram();
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.warn('program 連結失敗', gl.getProgramInfoLog(p));
    return null;
  }
  return p;
}

/* ---------- canvas2d 網格法（備援） ---------- */

function warpMesh(img, H, outW, outH, grid) {
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // 先把整張目的地網格點打表，省去重複投影
  const pts = [];
  for (let j = 0; j <= grid; j++) {
    const row = [];
    for (let i = 0; i <= grid; i++) {
      const dx = (i / grid) * outW;
      const dy = (j / grid) * outH;
      row.push({ d: [dx, dy], s: project(H, dx, dy) });
    }
    pts.push(row);
  }

  for (let j = 0; j < grid; j++) {
    for (let i = 0; i < grid; i++) {
      const a = pts[j][i], b = pts[j][i + 1], c = pts[j + 1][i + 1], d = pts[j + 1][i];
      drawTriangle(ctx, img, a, b, c);
      drawTriangle(ctx, img, a, c, d);
    }
  }
  return canvas;
}

/** 把來源三角形貼到目的地三角形。三角形之間會有次像素縫隙，往外撐一點蓋掉。 */
function drawTriangle(ctx, img, p0, p1, p2) {
  const [x0, y0] = p0.d, [x1, y1] = p1.d, [x2, y2] = p2.d;
  const [u0, v0] = p0.s, [u1, v1] = p1.s, [u2, v2] = p2.s;

  ctx.save();

  // 往形心外推 0.35px，相鄰三角形會重疊一點點，接縫就看不見了
  const cx = (x0 + x1 + x2) / 3, cy = (y0 + y1 + y2) / 3;
  const out = (x, y) => {
    const dx = x - cx, dy = y - cy;
    const len = Math.hypot(dx, dy) || 1;
    return [x + (dx / len) * 0.35, y + (dy / len) * 0.35];
  };
  const [ex0, ey0] = out(x0, y0), [ex1, ey1] = out(x1, y1), [ex2, ey2] = out(x2, y2);

  ctx.beginPath();
  ctx.moveTo(ex0, ey0);
  ctx.lineTo(ex1, ey1);
  ctx.lineTo(ex2, ey2);
  ctx.closePath();
  ctx.clip();

  // 解出把 (u,v) 映到 (x,y) 的仿射變換
  const det = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
  if (Math.abs(det) > 1e-9) {
    const a = ((x1 - x0) * (v2 - v0) - (x2 - x0) * (v1 - v0)) / det;
    const b = ((x2 - x0) * (u1 - u0) - (x1 - x0) * (u2 - u0)) / det;
    const c = ((y1 - y0) * (v2 - v0) - (y2 - y0) * (v1 - v0)) / det;
    const d = ((y2 - y0) * (u1 - u0) - (y1 - y0) * (u2 - u0)) / det;
    ctx.setTransform(a, c, b, d, x0 - a * u0 - b * v0, y0 - c * u0 - d * v0);
    ctx.drawImage(img, 0, 0);
  }
  ctx.restore();
}

/** 預設四角：整張圖。使用者還沒調整前用這個。 */
export const fullFrame = (w, h) => [[0, 0], [w, 0], [w, h], [0, h]];

/** 四角是否等同整張圖，用來判斷需不需要真的做變換。 */
export function isFullFrame(corners, w, h) {
  const want = fullFrame(w, h);
  return corners.every((p, i) =>
    Math.abs(p[0] - want[i][0]) < 0.5 && Math.abs(p[1] - want[i][1]) < 0.5);
}

/**
 * 把四個點排成左上、右上、右下、左下。
 * 使用者拖動時可能把角拖到對面去，順序亂掉會讓變換整個翻過來。
 */
export function orderCorners(pts) {
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const out = [null, null, null, null];
  for (const p of pts) {
    const right = p[0] >= cx, bottom = p[1] >= cy;
    const idx = !right && !bottom ? 0 : right && !bottom ? 1 : right && bottom ? 2 : 3;
    out[idx] = p;
  }
  // 有點落在同一象限時退回原順序，總比丟掉點好
  return out.every(Boolean) ? out : pts.slice(0, 4);
}
