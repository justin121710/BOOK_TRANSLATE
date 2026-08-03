import { tpl, setTitle, go } from '../ui/router.js';
import { toast, bad, pending } from '../ui/toast.js';
import { askText, askConfirm } from '../ui/dialog.js';
import { icon } from '../ui/icons.js';
import { hasKeys, missingKeys } from '../state/settings.js';
import * as db from '../state/db.js';

const STATUS_LABEL = {
  pending: '待處理',
  ocr: '已辨識',
  translated: '已翻譯',
  done: '完成',
  failed: '失敗',
};

export default async function homeView(root) {
  setTitle('書籍翻譯器');
  root.append(tpl('tpl-home'));

  const $ = (id) => root.querySelector('#' + id);

  if (!hasKeys()) {
    const warn = $('keyWarn');
    warn.hidden = false;
    warn.firstChild.textContent =
      `尚未設定 ${missingKeys().join(' 與 ')} 金鑰，無法開始翻譯。`;
  }

  /* ---------- 備份與還原 ---------- */

  const restoreInput = document.createElement('input');
  restoreInput.type = 'file';
  restoreInput.accept = '.zip,application/zip';
  restoreInput.hidden = true;
  restoreInput.addEventListener('change', async () => {
    const file = restoreInput.files?.[0];
    restoreInput.value = '';
    if (!file) return;

    const p = pending('還原中…');
    try {
      const { importProject } = await import('../state/backup.js');
      const r = await importProject(file);
      p.done(`已還原「${r.project.name}」共 ${r.pages} 頁`, 'ok');
      paint();
    } catch (e) {
      p.done();
      bad('還原失敗：' + e.message);
    }
  });

  const restoreBtn = document.createElement('button');
  restoreBtn.className = 'link';
  restoreBtn.textContent = '從備份還原';
  restoreBtn.addEventListener('click', () => restoreInput.click());

  const storageNote = root.querySelector('#storageNote');
  storageNote.append(restoreBtn, restoreInput);

  $('newProject').addEventListener('click', async () => {
    const name = await askText('新增書籍', {
      value: '', placeholder: '書名', okLabel: '建立',
      hint: '之後可以再改名。',
    });
    if (name === null) return;
    const p = await db.createProject(name.trim());
    go('project', { id: p.id });
  });

  await paint();

  async function paint() {
    const projects = await db.listProjects();
    $('emptyHint').hidden = projects.length > 0;

    const list = $('projectList');
    list.replaceChildren();

    for (const p of projects) {
      const stats = await db.projectStats(p.id);
      const li = document.createElement('li');

      const main = document.createElement('div');
      main.className = 'card-main';
      main.innerHTML =
        `<div class="card-title"></div>` +
        `<div class="card-sub"></div>`;
      // 書名是使用者輸入的，不能直接塞進 innerHTML
      main.querySelector('.card-title').textContent = p.name;
      main.querySelector('.card-sub').textContent = summarise(stats, p.updatedAt);

      const pill = document.createElement('span');
      const done = stats.by.done || 0;
      pill.className = 'pill ' + (stats.total && done === stats.total ? 'ok'
                                 : stats.by.failed ? 'bad'
                                 : stats.total ? 'busy' : '');
      pill.textContent = stats.total ? `${done}/${stats.total}` : '空的';

      li.append(main, pill);
      li.style.cursor = 'pointer';
      li.addEventListener('click', () => go('project', { id: p.id }));

      const del = document.createElement('button');
      del.className = 'icon-btn';
      del.append(icon('trash', { size: 18 }));
      del.setAttribute('aria-label', `刪除「${p.name}」`);
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        const yes = await askConfirm(`刪除「${p.name}」？`, {
          detail: '頁面影像與譯文都會一起消失，無法復原。',
          okLabel: '刪除', danger: true,
        });
        if (!yes) return;
        await db.deleteProject(p.id);
        toast('已刪除');
        paint();
      });
      li.append(del);

      list.append(li);
    }
  }
}

function summarise(stats, updatedAt) {
  const when = new Date(updatedAt).toLocaleDateString('zh-TW',
    { year: 'numeric', month: 'numeric', day: 'numeric' });
  if (!stats.total) return `尚未匯入頁面　${when}`;

  const parts = Object.entries(stats.by)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${STATUS_LABEL[k] || k} ${n}`);
  return `${stats.total} 頁　${parts.join('・')}　${when}`;
}
