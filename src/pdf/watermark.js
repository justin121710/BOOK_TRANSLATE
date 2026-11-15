const SPACE = /[\s\p{Cf}]/u;
const LATIN_OR_NUMBER = /[\p{Script=Latin}\p{N}]/u;

function fold(text) {
  return text.normalize('NFKC').toLowerCase();
}

export function watermarkPatterns(input) {
  return [...new Set(input.split(/\r?\n/).map(line =>
    fold(line).replace(/[\s\p{Cf}]/gu, '')).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
}

// 保留原始字串的位置，讓全半形、連字及空白正規化後仍能精確裁出正文。
export function excludeWatermarks(texts, patterns) {
  const full = texts.map(text => [{ start: 0, end: text.length }]);
  if (!patterns.length) return { runs: full, matches: [] };

  const map = [];
  let normalized = '';
  let separated = true;
  for (const [i, text] of texts.entries()) {
    separated = true;
    for (const { 0: part, index: start } of text.matchAll(/\P{M}[\p{M}\uFF9E\uFF9F]*|\p{M}+/gu)) {
      for (const ch of fold(part)) {
        if (SPACE.test(ch)) {
          separated = true;
        } else {
          normalized += ch;
          for (let j = 0; j < ch.length; j++) {
            map.push({ i, start, end: start + part.length, separated, ch });
            separated = false;
          }
        }
      }
    }
  }

  const removed = texts.map(() => []);
  const matches = [];
  for (let pos = 0; pos < map.length;) {
    const pattern = patterns.find(candidate => {
      if (!normalized.startsWith(candidate, pos)) return false;
      const first = map[pos];
      const last = map[pos + candidate.length - 1];
      const before = map[pos - 1];
      const after = map[pos + candidate.length];
      if (before?.i === first.i && before.start === first.start) return false;
      if (after?.i === last.i && after.start === last.start) return false;
      // 保護英文單字或編號的前後綴，例如不要把 COPY 從 COPYRIGHT 中刪掉。
      return (!before || first.separated || !LATIN_OR_NUMBER.test(first.ch) || !LATIN_OR_NUMBER.test(before.ch)) &&
             (!after || after.separated || !LATIN_OR_NUMBER.test(last.ch) || !LATIN_OR_NUMBER.test(after.ch));
    });
    if (!pattern) {
      pos++;
      continue;
    }

    const first = map[pos];
    const last = map[pos + pattern.length - 1];
    const parts = [];
    for (let i = first.i; i <= last.i; i++) {
      const start = i === first.i ? first.start : 0;
      const end = i === last.i ? last.end : texts[i].length;
      removed[i].push({ start, end });
      parts.push(texts[i].slice(start, end));
    }
    matches.push(parts.join(' '));
    pos += pattern.length;
  }

  const runs = removed.map((ranges, i) => {
    const kept = [];
    let start = 0;
    for (const range of ranges) {
      if (range.start > start) kept.push({ start, end: range.start });
      start = range.end;
    }
    if (start < texts[i].length) kept.push({ start, end: texts[i].length });
    return kept;
  });
  return { runs, matches };
}

export function isWatermarkLayer(name) {
  return /水印|浮水印|ウォーターマーク|透かし|water[\s_-]*mark/iu.test(name?.normalize('NFKC') ?? '');
}

// 在原本的字框內保留未被刪除的片段，避免把剩餘字拉寬到整行。
export function sliceWord(word, { start, end }, positions) {
  const text = word.text.slice(start, end);
  if (!text.trim()) return null;
  if (start === 0 && end === word.text.length) return word;
  const fraction = offset => positions?.get(offset) ??
    (Array.from(word.text.slice(0, offset)).length / Array.from(word.text).length);
  const first = fraction(start);
  const last = fraction(end);
  return {
    ...word,
    text,
    right: word.right.map(value => value * (last - first)),
    origin: word.origin.map((value, axis) => value + word.right[axis] * first),
    trailingSpace: end === word.text.length && word.trailingSpace,
  };
}
