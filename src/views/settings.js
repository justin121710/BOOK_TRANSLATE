import { tpl, setTitle } from '../ui/router.js';
import { toast, ok, pending } from '../ui/toast.js';
import { askConfirm } from '../ui/dialog.js';
import { icon } from '../ui/icons.js';
import { settings, clearKeys } from '../state/settings.js';
import * as db from '../state/db.js';
import { FONTS, fontStatus, loadFont, dropFont } from '../pdf/fonts.js';
import * as vision from '../api/vision.js';
import * as claude from '../api/claude.js';

export default function settingsView(root) {
  setTitle('設定');
  root.append(tpl('tpl-settings'));

  const $ = (id) => root.querySelector('#' + id);

  const kGoogle = $('kGoogle');
  const kClaude = $('kClaude');
  const mClaude = $('mClaude');

  kGoogle.value = settings.googleKey;
  kClaude.value = settings.claudeKey;
  mClaude.value = settings.model;

  // 顯示／隱藏金鑰
  root.querySelectorAll('[data-reveal]').forEach(btn => {
    btn.append(icon('eye', { size: 18 }));
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.reveal);
      const shown = input.type === 'text';
      input.type = shown ? 'password' : 'text';
      btn.replaceChildren(icon(shown ? 'eye' : 'eyeOff', { size: 18 }));
      btn.setAttribute('aria-label', shown ? '顯示金鑰' : '隱藏金鑰');
    });
  });

  $('saveKeys').addEventListener('click', () => {
    settings.googleKey = kGoogle.value.trim();
    settings.claudeKey = kClaude.value.trim();
    settings.model = mClaude.value;
    ok('已儲存');
    paintKeyStates();
  });

  mClaude.addEventListener('change', () => { settings.model = mClaude.value; });

  $('testKeys').addEventListener('click', async (e) => {
    // 測試打的是輸入框裡的值，使用者不必先按儲存
    settings.googleKey = kGoogle.value.trim();
    settings.claudeKey = kClaude.value.trim();
    settings.model = mClaude.value;

    e.target.disabled = true;
    const p = pending('測試中…');
    await Promise.all([
      probe('gStat', 'Google Vision', () => vision.ping()),
      probe('cStat', 'Claude', () => claude.ping()),
    ]);
    p.done();
    e.target.disabled = false;
  });

  async function probe(statId, label, fn) {
    const el = $(statId);
    el.textContent = `${label}：測試中…`;
    el.style.color = '';
    try {
      await fn();
      el.textContent = `${label}：可用`;
      el.style.color = 'var(--ok)';
    } catch (err) {
      el.textContent = `${label}：${err.message}`;
      el.style.color = 'var(--danger)';
    }
  }

  function paintKeyStates() {
    $('gStat').textContent = settings.googleKey ? '已設定，尚未測試' : '未設定';
    $('cStat').textContent = settings.claudeKey ? '已設定，尚未測試' : '未設定';
    $('gStat').style.color = '';
    $('cStat').style.color = '';
  }
  paintKeyStates();

  /* ---------- 字型 ---------- */

  const fontList = $('fontList');

  async function paintFonts() {
    const rows = await fontStatus();
    fontList.replaceChildren(...rows.map(f => {
      const li = document.createElement('li');
      const main = document.createElement('div');
      main.className = 'card-main';
      main.innerHTML =
        `<div class="card-title">${f.label}</div>` +
        `<div class="card-sub">${f.role}　${f.cached
          ? (f.byteLength / 1048576).toFixed(1) + ' MB 已快取'
          : '下載約 ' + (f.wireBytes / 1048576).toFixed(1) + ' MB，尚未下載'}</div>`;
      const pill = document.createElement('span');
      pill.className = 'pill ' + (f.cached ? 'ok' : '');
      pill.textContent = f.cached ? '已就緒' : '待下載';
      li.append(main, pill);

      if (f.cached) {
        const del = document.createElement('button');
        del.className = 'icon-btn';
        del.append(icon('trash', { size: 18 }));
        del.title = '刪除快取';
        del.setAttribute('aria-label', `刪除 ${f.label} 的快取`);
        del.addEventListener('click', async () => {
          await dropFont(f.id);
          toast(`已刪除 ${f.label} 的快取`);
          paintFonts(); paintQuota();
        });
        li.append(del);
      }
      return li;
    }));
  }
  paintFonts();

  $('fetchFonts').addEventListener('click', async (e) => {
    e.target.disabled = true;
    const p = pending('準備下載字型…');
    try {
      for (const spec of Object.values(FONTS)) {
        await loadFont(spec.id, (ratio) => {
          p.update(`${spec.label}　${Math.round(ratio * 100)}%`);
        });
      }
      p.done('字型已快取', 'ok');
    } catch (err) {
      p.done('字型下載失敗：' + err.message, 'bad');
    }
    e.target.disabled = false;
    paintFonts(); paintQuota();
  });

  /* ---------- 儲存空間 ---------- */

  async function paintQuota() {
    const est = await db.estimateUsage();
    $('quota').textContent = est
      ? `已使用 ${(est.usage / 1048576).toFixed(1)} MB，瀏覽器可用上限約 ${(est.quota / 1048576 / 1024).toFixed(1)} GB`
      : '這個瀏覽器不提供儲存空間估計';
  }
  paintQuota();

  $('wipe').addEventListener('click', async () => {
    const yes = await askConfirm('清除所有本機資料？', {
      detail: '所有書籍、頁面影像、譯文與 API 金鑰都會被刪除，無法復原。\n字型快取會保留。',
      okLabel: '全部清除', danger: true,
    });
    if (!yes) return;
    await db.wipeAll();
    clearKeys();
    kGoogle.value = '';
    kClaude.value = '';
    paintKeyStates();
    paintQuota();
    ok('已清除本機資料');
  });
}
