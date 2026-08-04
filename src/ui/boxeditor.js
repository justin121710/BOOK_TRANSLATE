/* 圖片框編輯器。
 *
 * 自動偵測必然會誤判（見 SPEC.md 衝突 3），所以這個手動關卡不能省：
 * 拖曳空白處新增一個框，點框選取，再拖角落調整或按刪除。
 */

const HANDLE = 11;      // 角落把手的顯示半徑
const GRAB = 26;        // 判定半徑，比顯示大一圈才好按
const MIN_SIZE = 12;    // 太小的框沒有意義，直接忽略

/**
 * @param {CanvasImageSource & {width:number,height:number}} image
 * @param {{x,y,w,h}[]} initial 影像像素座標
 * @param {{onChange?: (rects) => void}} opts
 */
export function boxEditor(image, initial, opts = {}) {
  const iw = image.width, ih = image.height;
  let rects = (initial || []).map(r => ({
    x: r.x, y: r.y, w: r.w, h: r.h, kind: r.kind || 'figure',
  }));
  let selected = -1;

  const el = document.createElement('div');
  el.className = 'boxeditor';
  const canvas = document.createElement('canvas');
  canvas.className = 'boxeditor-canvas';
  el.append(canvas);
  const ctx = canvas.getContext('2d');

  let scale = 1, offX = 0, offY = 0;
  let drag = null;   // { mode: 'new'|'move'|'resize', corner, startImg, orig }

  function layout() {
    const rect = el.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const cw = Math.max(1, rect.width), ch = Math.max(1, rect.height);
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

  const toScreen = (x, y) => [offX + x * scale, offY + y * scale];
  const toImage = (sx, sy) => [(sx - offX) / scale, (sy - offY) / scale];

  function draw() {
    const t = ctx.getTransform();
    const w = canvas.width / (t.a || 1), h = canvas.height / (t.d || 1);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(image, offX, offY, iw * scale, ih * scale);

    rects.forEach((r, i) => {
      const [x, y] = toScreen(r.x, r.y);
      const rw = r.w * scale, rh = r.h * scale;
      const active = i === selected;
      // 方程式框用紫色，和插圖一眼分得出來
      const eq = r.kind === 'equation';
      const hue = eq ? '170,120,235' : '90,160,240';

      ctx.fillStyle = active ? 'rgba(217,164,65,.18)' : `rgba(${hue},.14)`;
      ctx.fillRect(x, y, rw, rh);
      ctx.strokeStyle = active ? '#d9a441' : `rgba(${hue},.9)`;
      ctx.lineWidth = active ? 2.5 : 1.8;
      ctx.strokeRect(x, y, rw, rh);

      // 編號與類型，和清單對得起來
      const label = `${i + 1}${eq ? ' 式' : ''}`;
      ctx.font = '11px system-ui';
      const lw = Math.max(20, ctx.measureText(label).width + 10);
      ctx.fillStyle = active ? '#d9a441' : `rgba(${hue},.95)`;
      ctx.fillRect(x, y, lw, 16);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x + lw / 2, y + 8);

      if (active) {
        for (const [cx, cy] of corners(x, y, rw, rh)) {
          ctx.beginPath();
          ctx.arc(cx, cy, HANDLE, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(217,164,65,.95)';
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = '#fff';
          ctx.stroke();
        }
      }
    });

    if (drag?.mode === 'new' && drag.current) {
      const [x0, y0] = toScreen(...drag.startImg);
      const [x1, y1] = toScreen(...drag.current);
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = '#d9a441';
      ctx.lineWidth = 2;
      ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.setLineDash([]);
    }
  }

  const corners = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

  function localPoint(ev) {
    const r = canvas.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  }

  function hitTest(sx, sy) {
    // 先看選取中那個框的角落，再看有沒有點進任何框
    if (selected >= 0) {
      const r = rects[selected];
      const [x, y] = toScreen(r.x, r.y);
      const cs = corners(x, y, r.w * scale, r.h * scale);
      for (let c = 0; c < 4; c++) {
        if (Math.hypot(cs[c][0] - sx, cs[c][1] - sy) < GRAB) {
          return { mode: 'resize', corner: c, index: selected };
        }
      }
    }
    // 由上往下找，重疊時取最後畫的那個
    for (let i = rects.length - 1; i >= 0; i--) {
      const r = rects[i];
      const [x, y] = toScreen(r.x, r.y);
      if (sx >= x && sy >= y && sx <= x + r.w * scale && sy <= y + r.h * scale) {
        return { mode: 'move', index: i };
      }
    }
    return null;
  }

  function onDown(ev) {
    const [sx, sy] = localPoint(ev);
    const hit = hitTest(sx, sy);
    canvas.setPointerCapture(ev.pointerId);
    ev.preventDefault();

    if (hit) {
      selected = hit.index;
      const r = rects[selected];
      drag = { ...hit, startImg: toImage(sx, sy), orig: { ...r } };
    } else {
      selected = -1;
      drag = { mode: 'new', startImg: toImage(sx, sy), current: toImage(sx, sy) };
    }
    draw();
  }

  function onMove(ev) {
    if (!drag) return;
    const [sx, sy] = localPoint(ev);
    const [ix, iy] = toImage(sx, sy);
    ev.preventDefault();

    if (drag.mode === 'new') {
      drag.current = [clamp(ix, 0, iw), clamp(iy, 0, ih)];
    } else if (drag.mode === 'move') {
      const dx = ix - drag.startImg[0], dy = iy - drag.startImg[1];
      const r = rects[drag.index];
      r.x = clamp(drag.orig.x + dx, 0, iw - r.w);
      r.y = clamp(drag.orig.y + dy, 0, ih - r.h);
    } else {
      const r = rects[drag.index];
      const o = drag.orig;
      // 依抓住的角落決定哪兩邊跟著動
      const left = drag.corner === 0 || drag.corner === 3;
      const top = drag.corner === 0 || drag.corner === 1;
      const x0 = left ? clamp(ix, 0, o.x + o.w - MIN_SIZE) : o.x;
      const y0 = top ? clamp(iy, 0, o.y + o.h - MIN_SIZE) : o.y;
      const x1 = left ? o.x + o.w : clamp(ix, o.x + MIN_SIZE, iw);
      const y1 = top ? o.y + o.h : clamp(iy, o.y + MIN_SIZE, ih);
      r.x = x0; r.y = y0; r.w = x1 - x0; r.h = y1 - y0;
    }
    draw();
  }

  function onUp(ev) {
    if (!drag) return;
    if (drag.mode === 'new' && drag.current) {
      const [x0, y0] = drag.startImg, [x1, y1] = drag.current;
      const r = {
        x: Math.min(x0, x1), y: Math.min(y0, y1),
        w: Math.abs(x1 - x0), h: Math.abs(y1 - y0),
        kind: opts.defaultKind || 'figure',
      };
      // 只是點一下而不是拖曳，不要留下一個看不見的框
      if (r.w >= MIN_SIZE && r.h >= MIN_SIZE) {
        rects.push(r);
        selected = rects.length - 1;
      }
    }
    drag = null;
    canvas.releasePointerCapture?.(ev.pointerId);
    draw();
    opts.onChange?.(current());
  }

  const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
  const current = () => rects.map(r => ({
    x: Math.round(r.x), y: Math.round(r.y),
    w: Math.round(r.w), h: Math.round(r.h),
    kind: r.kind || 'figure',
  }));

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);

  const ro = new ResizeObserver(layout);
  ro.observe(el);
  requestAnimationFrame(layout);

  return {
    el,
    rects: current,
    get selectedIndex() { return selected; },
    removeSelected() {
      if (selected < 0) return false;
      rects.splice(selected, 1);
      selected = -1;
      draw();
      opts.onChange?.(current());
      return true;
    },
    /** 切換選取的框是插圖還是方程式。 */
    toggleKind() {
      if (selected < 0) return null;
      const r = rects[selected];
      r.kind = r.kind === 'equation' ? 'figure' : 'equation';
      draw();
      opts.onChange?.(current());
      return r.kind;
    },
    clear() {
      rects = [];
      selected = -1;
      draw();
      opts.onChange?.(current());
    },
    set(next) {
      rects = (next || []).map(r => ({ ...r }));
      selected = -1;
      draw();
      opts.onChange?.(current());
    },
    destroy() {
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
    },
  };
}
