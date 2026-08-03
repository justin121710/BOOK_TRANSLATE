/* PDF 原生文字層 → 和 Vision 那條路一樣的 block 形狀。
   pdf.js 給的是一段一段的文字項目，本身沒有「段落」的概念，
   所以要靠位置把相鄰的行併成塊。 */

export function parseNative(items, opts = {}) {
  if (!items?.length) return { blocks: [], vertical: false, rubyDropped: [] };

  const lines = items.map(it => ({
    text: it.str,
    vertical: Boolean(it.vertical),
    x: it.bbox[0], y: it.bbox[1], w: it.bbox[2], h: it.bbox[3],
  }));

  const verticalChars = lines.filter(l => l.vertical).reduce((s, l) => s + l.text.length, 0);
  const totalChars = lines.reduce((s, l) => s + l.text.length, 0);
  const vertical = totalChars > 0 && verticalChars / totalChars > 0.5;

  const size = medianOf(lines.map(l => vertical ? l.w : l.h)) || 12;
  const groups = groupIntoBlocks(lines, vertical, size);

  const blocks = groups.map(g => {
    const x = Math.min(...g.map(l => l.x));
    const y = Math.min(...g.map(l => l.y));
    const r = Math.max(...g.map(l => l.x + l.w));
    const b = Math.max(...g.map(l => l.y + l.h));
    return {
      vertical,
      bbox: [x, y, r - x, b - y],
      poly: null,
      srcText: g.map(l => l.text).join('\n'),
      dstText: null,
      fontSize: medianOf(g.map(l => vertical ? l.w : l.h)) || size,
      lines: g.map(l => ({ text: l.text, bbox: [l.x, l.y, l.w, l.h] })),
      kind: 'body',
      skipTranslate: false,
    };
  });

  const ordered = orderBlocks(blocks, vertical, size);
  ordered.forEach((b, i) => { b.order = i; });

  // 原生文字層沒有振り仮名的概念（它們在 PDF 裡就是獨立的小字文字項目），
  // 這裡不做剔除；真的遇到會在預覽頁看得出來，交給單塊重跑處理
  return { blocks: ordered, vertical, rubyDropped: [] };
}

/**
 * 把行併成塊。相鄰、對齊、行距正常的行視為同一段。
 * 直排時「相鄰」是水平方向的相鄰，因為欄是往左推進的。
 */
function groupIntoBlocks(lines, vertical, size) {
  const sorted = [...lines].sort((a, b) => vertical
    ? (b.x - a.x) || (a.y - b.y)      // 直排：由右往左
    : (a.y - b.y) || (a.x - b.x));

  const gapLimit = size * 2.2;         // 超過兩行的間距就當成另一段
  const alignLimit = size * 1.2;

  const groups = [];
  let current = null;

  for (const line of sorted) {
    if (!current) { current = [line]; groups.push(current); continue; }

    const prev = current[current.length - 1];
    const gap = vertical
      ? prev.x - (line.x + line.w)                       // 前一欄左緣到這一欄右緣
      : line.y - (prev.y + prev.h);
    // 起始邊對齊程度：直排看頂端，橫排看左緣
    const align = vertical ? Math.abs(line.y - prev.y) : Math.abs(line.x - prev.x);

    if (gap <= gapLimit && gap >= -size && align <= alignLimit * 3) current.push(line);
    else { current = [line]; groups.push(current); }
  }
  return groups;
}

function orderBlocks(blocks, vertical, size) {
  const band = size * 1.6 || 24;
  return [...blocks].sort((a, b) => {
    if (vertical) {
      const ax = a.bbox[0] + a.bbox[2], bx = b.bbox[0] + b.bbox[2];
      if (Math.abs(ax - bx) > band) return bx - ax;
      return a.bbox[1] - b.bbox[1];
    }
    if (Math.abs(a.bbox[1] - b.bbox[1]) > band) return a.bbox[1] - b.bbox[1];
    return a.bbox[0] - b.bbox[0];
  });
}

function medianOf(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
