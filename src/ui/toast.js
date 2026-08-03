/* 短暫提示。刻意不做佇列上限以外的邏輯 —— 錯誤訊息要能疊著看。 */

const host = () => document.getElementById('toasts');

export function toast(message, kind = '', ms = 3200) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = message;
  host().append(el);

  const kill = () => {
    el.style.transition = 'opacity .2s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  };
  setTimeout(kill, ms);
  return kill;
}

export const ok  = (m, ms) => toast(m, 'ok', ms);
export const bad = (m, ms) => toast(m, 'bad', ms ?? 5200);

/** 顯示到工作結束為止的提示，回傳一個關掉它的函式。 */
export function pending(message) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  host().append(el);
  return {
    update(text) { el.textContent = text; },
    done(text, kind = 'ok') {
      if (text) { el.textContent = text; el.className = 'toast ' + kind; }
      setTimeout(() => {
        el.style.transition = 'opacity .2s';
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 220);
      }, text ? 1800 : 0);
    },
  };
}
