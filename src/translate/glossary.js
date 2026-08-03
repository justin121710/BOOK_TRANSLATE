/* 全書專有名詞對照表。
   同一個人名在第 3 頁和第 200 頁譯法不一致，整本書就毀了，
   所以每頁翻譯都把現有詞表帶進去，並把新出現的詞收回來。 */

import * as db from '../state/db.js';

export async function load(projectId) {
  const rows = await db.getBy('glossary', 'projectId', projectId);
  // 出現次數多的排前面：詞表若要截斷，先保住最重要的
  return rows.sort((a, b) => (b.count || 0) - (a.count || 0));
}

/**
 * 收進本頁回報的新詞。
 * 已存在的只加計次，不覆蓋既有譯法 —— 先出現的譯法就是全書的標準，
 * 讓後面的頁面改寫它反而會製造不一致。
 */
export async function merge(projectId, entries) {
  if (!entries?.length) return { added: 0, seen: 0 };

  const existing = await db.getBy('glossary', 'projectId', projectId);
  const byJa = new Map(existing.map(e => [e.ja, e]));

  const writes = [];
  let added = 0, seen = 0;

  for (const e of entries) {
    const ja = (e.ja || '').trim();
    const zh = (e.zh || '').trim();
    if (!ja || !zh) continue;

    const hit = byJa.get(ja);
    if (hit) {
      hit.count = (hit.count || 1) + 1;
      writes.push(hit);
      seen++;
    } else {
      const row = {
        id: db.uid('gl_'),
        projectId,
        ja, zh,
        note: (e.note || '').trim(),
        count: 1,
        createdAt: Date.now(),
      };
      byJa.set(ja, row);
      writes.push(row);
      added++;
    }
  }

  if (writes.length) await db.putMany('glossary', writes);
  return { added, seen };
}

/** 詞表太長會吃掉大量 token，超過上限時只帶最常出現的。 */
export function trim(entries, max = 120) {
  return entries.length <= max ? entries : entries.slice(0, max);
}

export async function update(id, patch) {
  const row = await db.get('glossary', id);
  if (!row) return null;
  const next = { ...row, ...patch };
  await db.put('glossary', next);
  return next;
}

export const remove = (id) => db.del('glossary', id);
