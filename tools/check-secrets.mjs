/* 掃描即將提交的內容裡有沒有 API 金鑰。
   金鑰本來就不該進 repo —— App 是把它存在瀏覽器 localStorage 裡的 ——
   但一次手滑就足以讓公開 repo 上的金鑰在幾分鐘內被爬蟲撿走，所以加一道機械式的防線。

   用法：
     node tools/check-secrets.mjs            掃已 staged 的內容（pre-commit 用）
     node tools/check-secrets.mjs --all      掃整個工作目錄
*/

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PATTERNS = [
  { name: 'Google API 金鑰',      re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Anthropic API 金鑰',   re: /\bsk-ant-[A-Za-z0-9_-]{24,}/ },
  { name: 'OpenAI API 金鑰',      re: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: 'GitHub token',        re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/ },
  { name: 'GitHub PAT',          re: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/ },
  { name: 'Google 服務帳戶私鑰',   re: /"type"\s*:\s*"service_account"/ },
];

// 這支檔案自己就含有樣式，掃到會誤判
const SKIP = new Set(['tools/check-secrets.mjs']);

const all = process.argv.includes('--all');
const hits = [];

function scan(file, text) {
  if (SKIP.has(file.replace(/\\/g, '/'))) return;
  text.split('\n').forEach((line, i) => {
    for (const p of PATTERNS) {
      if (p.re.test(line)) {
        hits.push({ file, line: i + 1, name: p.name, text: line.trim().slice(0, 90) });
      }
    }
  });
}

if (all) {
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'icons'].includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (fs.statSync(full).size > 2_000_000) continue;
      try {
        scan(path.relative(process.cwd(), full), fs.readFileSync(full, 'utf8'));
      } catch { /* 二進位檔跳過 */ }
    }
  };
  walk(process.cwd());
} else {
  const staged = execSync('git diff --cached --name-only --diff-filter=ACM', { encoding: 'utf8' })
    .split('\n').filter(Boolean);
  for (const file of staged) {
    let text;
    try {
      // 讀 index 裡的版本，而不是工作目錄 —— 提交的是前者
      text = execSync(`git show :${JSON.stringify(file)}`, { encoding: 'utf8', maxBuffer: 20e6 });
    } catch { continue; }
    scan(file, text);
  }
}

if (hits.length) {
  console.error('\n  提交被擋下：內容裡出現了看起來像 API 金鑰的東西\n');
  for (const h of hits) {
    console.error(`  ${h.file}:${h.line}  ${h.name}`);
    console.error(`    ${h.text}\n`);
  }
  console.error('  金鑰應該只存在 App 設定頁（瀏覽器 localStorage），不要寫進程式碼。');
  console.error('  如果這是誤判，用 git commit --no-verify 略過。\n');
  process.exit(1);
}

if (all) console.log('乾淨，沒有找到金鑰樣式。');
