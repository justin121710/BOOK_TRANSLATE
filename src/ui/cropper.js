/* 四角校正編輯器。
   手指會蓋住要對準的那個角，所以拖動時在對角落顯示放大鏡。 */

import { fullFrame, orderCorners } from '../preprocess/warp.js';

const HANDLE_R = 14;       // 顯示半徑（CSS 像素）
const GRAB_R = 30;         // 判定半徑，比顯示大一圈才好按
const LOUPE = 108;
const LOUPE_ZOOM = 2.6;

/**
 * @param {CanvasImageSource & {width:number,height:number}} image
 * @param {[number,number][]|null} initial 影像像素座標
 * @returns {{el: HTMLElement, corners: () => [number,number][], reset: () => void, destroy: () => void}}
 */
export function cropper(image, initial) {
  const iw = image.width, ih = image.height;

  let corners = (initial && initial.length === 4)
    ? initial.map(p => [...p])
    // 預設往內縮 4%，使用者一眼就看得出這幾個點是可以拖的
    : [[iw * .04, ih * .04], [iw * .96, ih * .04], [iw * .96, ih * .96], [iw * .04, ih * .96]];

  const el = document.createElement('div');
  el.className = 'cropper';

  const canvas = document.createElement('canvas');
  canvas.className = 'cropper-canvas';
  el.append(canvas);
  const ctx = canvas.getContext('2d');

  let scale = 1, offX = 0, offY = 0, dragging = -1, pointer = null;

  function layout() {
    const rect = el.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const cw = Math.max(1, rect.width);
    const ch = Math.max(1, rect.height);

    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    canvas.style.width = cw + 'px';
    canvas.style.height = ch + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    scale = Math.min(cw / iw, ch / ih);
    offX = (cw - iw * scale) / 2;
    offY = (ch - ih * scale) / 2;
    draw();
  }

  const toScreen = ([x, y]) => [offX + x * scale, offY + y * scale];
  const toImage = (sx, sy) => [(sx - offX) / scale, (sy - offY) / scale];

  function draw() {
    const w = canvas.width / (ctx.getTransform().a || 1);
    const h = canvas.height / (ctx.getTransform().d || 1);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(image, offX, offY, iw * scale, ih * scale);

    const pts = corners.map(toScreen);

    // 選取範圍外的區域壓暗
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = pts.length - 1; i >= 1; i--) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.fill('evenodd');
    ctx.restore();

    // 邊框
    ctx.strokeStyle = '#d9a441';
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    ctx.closePath();
    ctx.stroke();

    // 三分格輔助線
    ctx.strokeStyle = 'rgba(217,164,65,.28)';
    ctx.lineWidth = 1;
    for (let k = 1; k <= 2; k++) {
      const t = k / 3;
      const lerp = (a, b) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const top = lerp(pts[0], pts[1]), bottom = lerp(pts[3], pts[2]);
      const left = lerp(pts[0], pts[3]), right = lerp(pts[1], pts[2]);
      ctx.beginPath(); ctx.moveTo(...top); ctx.lineTo(...bottom); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(...left); ctx.lineTo(...right); ctx.stroke();
    }

    // 角把手
    pts.forEach(([x, y], i) => {
      const active = i === dragging;
      ctx.beginPath();
      ctx.arc(x, y, active ? HANDLE_R + 3 : HANDLE_R, 0, Math.PI * 2);
      ctx.fillStyle = active ? 'rgba(217,164,65,.95)' : 'rgba(217,164,65,.35)';
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    });

    if (dragging >= 0 && pointer) drawLoupe(pts[dragging], w, h);
  }

  /** 放大鏡：貼在離手指最遠的角落，才不會被手擋住。 */
  function drawLoupe([sx, sy], w, h) {
    const pad = 12;
    const lx = sx < w / 2 ? w - LOUPE - pad : pad;
    const ly = sy < h / 2 ? h - LOUPE - pad : pad;

    ctx.save();
    ctx.beginPath();
    ctx.arc(lx + LOUPE / 2, ly + LOUPE / 2, LOUPE / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.clip();

    const [ix, iy] = toImage(sx, sy);
    const srcSpan = LOUPE / LOUPE_ZOOM / scale;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      image,
      ix - srcSpan / 2, iy - srcSpan / 2, srcSpan, srcSpan,
      lx, ly, LOUPE, LOUPE);

    // 十字準心
    ctx.strokeStyle = '#d9a441';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(lx + LOUPE / 2 - 10, ly + LOUPE / 2); ctx.lineTo(lx + LOUPE / 2 + 10, ly + LOUPE / 2);
    ctx.moveTo(lx + LOUPE / 2, ly + LOUPE / 2 - 10); ctx.lineTo(lx + LOUPE / 2, ly + LOUPE / 2 + 10);
    ctx.stroke();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(lx + LOUPE / 2, ly + LOUPE / 2, LOUPE / 2, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  /* ---------- 互動 ---------- */

  function localPoint(ev) {
    const r = canvas.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  }

  function onDown(ev) {
    const [sx, sy] = localPoint(ev);
    let best = -1, bestD = GRAB_R;
    corners.forEach((c, i) => {
      const [cx, cy] = toScreen(c);
      const d = Math.hypot(cx - sx, cy - sy);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best < 0) return;

    dragging = best;
    pointer = [sx, sy];
    canvas.setPointerCapture(ev.pointerId);
    ev.preventDefault();
    draw();
  }

  function onMove(ev) {
    if (dragging < 0) return;
    const [sx, sy] = localPoint(ev);
    pointer = [sx, sy];
    const [ix, iy] = toImage(sx, sy);
    corners[dragging] = [
      Math.min(Math.max(ix, 0), iw),
      Math.min(Math.max(iy, 0), ih),
    ];
    ev.preventDefault();
    draw();
  }

  function onUp(ev) {
    if (dragging < 0) return;
    dragging = -1;
    pointer = null;
    // 拖過頭讓角跑到對面時把順序轉正，不然變換會整個翻掉
    corners = orderCorners(corners);
    canvas.releasePointerCapture?.(ev.pointerId);
    draw();
  }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);

  const ro = new ResizeObserver(layout);
  ro.observe(el);
  // ResizeObserver 第一次觸發要等一個 frame，先畫一次避免閃爍
  requestAnimationFrame(layout);

  return {
    el,
    corners: () => orderCorners(corners).map(p => [...p]),
    reset() { corners = fullFrame(iw, ih); draw(); },
    destroy() {
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
    },
  };
}
