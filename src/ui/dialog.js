/* 自製對話框。
   不用 window.prompt / confirm：iOS 的 standalone PWA 對它們的支援不一致，
   內嵌瀏覽器更是直接丟 "prompt() is not supported"。 */

function shell({ title, body, actions }) {
  const dlg = document.createElement('dialog');
  dlg.className = 'dlg';

  const form = document.createElement('form');
  form.method = 'dialog';

  if (title) {
    const h = document.createElement('h3');
    h.className = 'dlg-title';
    h.textContent = title;
    form.append(h);
  }
  if (body) form.append(body);

  const row = document.createElement('div');
  row.className = 'dlg-actions';
  for (const a of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn' + (a.primary ? ' btn-primary' : '') + (a.danger ? ' btn-danger' : '');
    b.textContent = a.label;
    b.addEventListener('click', () => a.onClick(dlg));
    row.append(b);
  }
  form.append(row);
  dlg.append(form);
  document.body.append(dlg);

  // 點背景關閉
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('close', () => dlg.remove());

  dlg.showModal();
  return dlg;
}

/** @returns {Promise<string|null>} 取消時為 null */
export function askText(title, { value = '', placeholder = '', hint = '', okLabel = '確定' } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    const body = document.createElement('div');
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    input.placeholder = placeholder;
    body.append(input);

    if (hint) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = hint;
      body.append(p);
    }

    const dlg = shell({
      title,
      body,
      actions: [
        { label: '取消', onClick: (d) => { done(null); d.close(); } },
        { label: okLabel, primary: true, onClick: (d) => { done(input.value); d.close(); } },
      ],
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); done(input.value); dlg.close(); }
    });
    dlg.addEventListener('close', () => done(null));

    // iOS 需要一個 tick 才會把鍵盤叫起來
    setTimeout(() => { input.focus(); input.select(); }, 50);
  });
}

/** @returns {Promise<boolean>} */
export function askConfirm(title, { detail = '', okLabel = '確定', danger = false } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    let body = null;
    if (detail) {
      body = document.createElement('p');
      body.className = 'dlg-detail';
      body.textContent = detail;
    }

    const dlg = shell({
      title,
      body,
      actions: [
        { label: '取消', onClick: (d) => { done(false); d.close(); } },
        { label: okLabel, primary: !danger, danger, onClick: (d) => { done(true); d.close(); } },
      ],
    });
    dlg.addEventListener('close', () => done(false));
  });
}
