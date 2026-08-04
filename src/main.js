import { route, start } from './ui/router.js';
import { toast, bad } from './ui/toast.js';
import * as dbmod from './state/db.js';

import home from './views/home.js';
import project from './views/project.js';
import page from './views/page.js';
import review from './views/review.js';
import glossaryView from './views/glossary.js';
import settingsView from './views/settings.js';

route('home', home);
route('project', project);
route('page', page);
route('review', review);
route('glossary', glossaryView);
route('settings', settingsView);

// 未攔截的錯誤在手機上完全看不到，一定要浮出來
addEventListener('error', (e) => {
  console.error(e.error || e.message);
  bad('發生錯誤：' + (e.error?.message || e.message));
});
addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
  bad('發生錯誤：' + (e.reason?.message || e.reason));
});

async function boot() {
  try {
    await dbmod.open();
  } catch (e) {
    bad('無法開啟本機資料庫：' + e.message);
  }

  // 批次處理途中被瀏覽器清掉資料會很痛，能要就先要
  if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
    navigator.storage.persist().catch(() => {});
  }

  await start();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js')
      .then(watchForUpdate)
      .catch(err => console.warn('service worker 註冊失敗', err));
  }
}

/**
 * 有新版本時提示重新載入。
 *
 * 沒有這個提示的話，加到主畫面的圖示可能長期跑著舊版而使用者不知道 ——
 * 更新是靜默發生的，而且要等到下一次完全關閉再開才會生效。
 */
function watchForUpdate(reg) {
  if (!reg) return;

  const offerReload = (worker) => {
    // 已經有一個 controller 才算「更新」，第一次安裝不用打擾使用者
    if (!navigator.serviceWorker.controller) return;

    const t = toast('有新版本，點這裡重新載入', 'ok', 30000);
    const el = document.querySelector('#toasts .toast:last-child');
    if (el) {
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => {
        worker.postMessage({ type: 'SKIP_WAITING' });
        location.reload();
      });
    }
    return t;
  };

  if (reg.waiting) offerReload(reg.waiting);

  reg.addEventListener('updatefound', () => {
    const next = reg.installing;
    if (!next) return;
    next.addEventListener('statechange', () => {
      if (next.state === 'installed') offerReload(next);
    });
  });

  // 回到前景時再查一次，手機上 App 常常一放就是好幾天
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reg.update().catch(() => {});
  });
}

boot();
