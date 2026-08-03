import { setTitle, go } from '../ui/router.js';
import { askText, askConfirm } from '../ui/dialog.js';
import * as db from '../state/db.js';

/* M2 會把這頁換成真正的頁面清單與匯入介面。
   目前只做到能建立書籍、改名、看到空狀態。 */

export default async function projectView(root, { id }) {
  const project = id && await db.get('projects', id);
  if (!project) {
    setTitle('找不到這本書');
    const p = document.createElement('section');
    p.className = 'view pad';
    p.innerHTML = `<h2>找不到這本書</h2>
      <p class="hint">它可能已經被刪除了。</p>
      <button class="btn" data-go="home">回到書櫃</button>`;
    root.append(p);
    return;
  }

  setTitle(project.name);

  const sec = document.createElement('section');
  sec.className = 'view pad';

  const head = document.createElement('div');
  head.className = 'row-between';
  const h = document.createElement('h2');
  h.textContent = project.name;
  const rename = document.createElement('button');
  rename.className = 'btn';
  rename.textContent = '改名';
  rename.addEventListener('click', async () => {
    const next = await askText('書名', { value: project.name, okLabel: '儲存' });
    if (next === null) return;
    project.name = next.trim() || project.name;
    project.updatedAt = Date.now();
    await db.put('projects', project);
    setTitle(project.name);
    h.textContent = project.name;
  });
  head.append(h, rename);

  const pages = await db.getBy('pages', 'projectId', project.id);

  const body = document.createElement('div');
  if (pages.length === 0) {
    body.innerHTML = `
      <div class="banner banner-info">
        還沒有任何頁面。匯入介面（相機、相簿、PDF、EPUB）與透視校正在 M2 實作。
      </div>`;
  } else {
    body.innerHTML = `<p class="hint">${pages.length} 頁</p>`;
  }

  const del = document.createElement('button');
  del.className = 'btn btn-danger';
  del.textContent = '刪除這本書';
  del.style.marginTop = '24px';
  del.addEventListener('click', async () => {
    const yes = await askConfirm(`刪除「${project.name}」？`, {
      detail: '頁面影像與譯文都會一起消失，無法復原。',
      okLabel: '刪除', danger: true,
    });
    if (!yes) return;
    await db.deleteProject(project.id);
    go('home');
  });

  sec.append(head, body, del);
  root.append(sec);
}
