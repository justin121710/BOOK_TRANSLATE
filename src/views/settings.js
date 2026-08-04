import { tpl, setTitle } from '../ui/router.js';
import { toast, ok, pending } from '../ui/toast.js';
import { askConfirm } from '../ui/dialog.js';
import { icon } from '../ui/icons.js';
import { settings, clearKeys } from '../state/settings.js';
import * as db from '../state/db.js';
import { FONTS, fontStatus, loadFont, dropFont } from '../pdf/fonts.js';
import * as vision from '../api/vision.js';
import * as claude from '../api/claude.js';
import * as gemini from '../api/gemini.js';
import { VERSION } from '../version.js';

export default function settingsView(root) {
  setTitle('設定');
  root.append(tpl('tpl-settings'));

  const $ = (id) => root.querySelector('#' + id);

  const kGoogle = $('kGoogle');
  const kClaude = $('kClaude');
  const kGemini = $('kGemini');
  const mClaude = $('mClaude');
  const mGemini = $('mGemini');
  const provider = $('provider');

  kGoogle.value = settings.googleKey;
  kClaude.value = settings.claudeKey;
  kGemini.value = settings.geminiKey;
  mClaude.value = settings.model;
  provider.value = settings.provider;

  /* ---------- 供應商切換 ---------- */

  function paintProvider() {
    const isGemini = provider.value === 'gemini';
    $('geminiFields').hidden = !isGemini;
    $('claudeFields').hidden = isGemini;
    // 兩家在「無法限制來源」這點上是打平的，別把 Gemini 講得比較安全
    $('providerHint').textContent = isGemini
      ? '有免費額度，帳號你已經有了。金鑰通常要另外申請一把，且無法設來源限制。'
      : '品質可能較好。需要另一把 Anthropic 金鑰，同樣無法設來源限制。';

    // 資料會流到哪裡取決於選了誰，這句不能寫死
    $('privacyNote').textContent =
      '金鑰只存在這支手機的瀏覽器裡，不會上傳到任何伺服器。' +
      '書頁影像會送往 Google Cloud Vision 辨識，文字會送往 ' +
      (isGemini ? 'Google Gemini' : 'Anthropic') + ' 翻譯。';
  }
  provider.addEventListener('change', () => {
    settings.provider = provider.value;
    paintProvider();
    paintKeyStates();
  });
  paintProvider();

  /* ---------- Gemini 模型清單 ---------- */

  // 硬寫模型清單很快就會過時，所以先放已知的，再讓使用者用金鑰向 API 要真正可用的
  function fillModels(list) {
    mGemini.replaceChildren(...list.map(m => {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.label || m.id;
      return o;
    }));
    // 記住的模型若不在清單裡，補一個選項免得選到別的
    if (!list.some(m => m.id === settings.geminiModel)) {
      const o = document.createElement('option');
      o.value = settings.geminiModel;
      o.textContent = settings.geminiModel + '（未在清單中）';
      mGemini.prepend(o);
    }
    mGemini.value = settings.geminiModel;
  }

  fillModels([
    { id: 'gemini-2.5-flash', label: 'gemini-2.5-flash — 快且便宜' },
    { id: 'gemini-2.5-pro',   label: 'gemini-2.5-pro — 品質較好' },
  ]);

  mGemini.addEventListener('change', () => { settings.geminiModel = mGemini.value; });

  $('refreshModels').addEventListener('click', async (e) => {
    settings.googleKey = kGoogle.value.trim();
    settings.geminiKey = kGemini.value.trim();
    e.target.disabled = true;
    const el = $('gemStat');
    el.textContent = '查詢可用模型…';
    el.style.color = '';
    try {
      const models = await gemini.listModels();
      fillModels(models);
      el.textContent = `找到 ${models.length} 個可用模型`;
      el.style.color = 'var(--ok)';
    } catch (err) {
      el.textContent = err.message;
      el.style.color = 'var(--danger)';
    }
    e.target.disabled = false;
  });

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

  function commit() {
    settings.googleKey = kGoogle.value.trim();
    settings.claudeKey = kClaude.value.trim();
    settings.geminiKey = kGemini.value.trim();
    settings.model = mClaude.value;
    settings.geminiModel = mGemini.value;
    settings.provider = provider.value;
  }

  $('saveKeys').addEventListener('click', () => {
    commit();
    ok('已儲存');
    paintKeyStates();
  });

  mClaude.addEventListener('change', () => { settings.model = mClaude.value; });

  $('testKeys').addEventListener('click', async (e) => {
    commit();   // 測試打的是輸入框裡的值，使用者不必先按儲存

    e.target.disabled = true;
    const p = pending('測試中…');
    const jobs = [probe('gStat', 'Google Vision', () => vision.ping())];
    if (settings.provider === 'gemini') {
      jobs.push(probe('gemStat', 'Gemini', async () => {
        const models = await gemini.ping();
        return `可用，找到 ${models.length} 個模型`;
      }));
    } else {
      jobs.push(probe('cStat', 'Claude', () => claude.ping()));
    }
    await Promise.all(jobs);
    p.done();
    e.target.disabled = false;
  });

  async function probe(statId, label, fn) {
    const el = $(statId);
    el.textContent = `${label}：測試中…`;
    el.style.color = '';
    try {
      const detail = await fn();
      el.textContent = `${label}：${typeof detail === 'string' ? detail : '可用'}`;
      el.style.color = 'var(--ok)';
    } catch (err) {
      el.textContent = `${label}：${err.message}`;
      el.style.color = 'var(--danger)';
    }
  }

  function paintKeyStates() {
    const set = (id, has, extra = '') => {
      $(id).textContent = has ? '已設定，尚未測試' + extra : '未設定';
      $(id).style.color = '';
    };
    set('gStat', Boolean(settings.googleKey));
    set('cStat', Boolean(settings.claudeKey));
    set('gemStat', Boolean(settings.geminiKey || settings.googleKey),
        settings.geminiKey ? '' : '（沿用上面的 Google 金鑰）');
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

  // 看得到自己在跑哪一版，回報問題時才對得起來
  $('version').textContent = `版本 ${VERSION}`;

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
