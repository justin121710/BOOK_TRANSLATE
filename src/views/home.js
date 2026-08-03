import { tpl, setTitle, go } from '../ui/router.js';
import { toast } from '../ui/toast.js';
import { askText, askConfirm } from '../ui/dialog.js';
import { hasKeys, missingKeys } from '../state/settings.js';
import * as db from '../state/db.js';

const STATUS_LABEL = {
  pending: '待處理',
  ocr: '辨識中',
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
      del.textContent = '🗑';
      del.setAttribute('aria-label', '刪除');
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
