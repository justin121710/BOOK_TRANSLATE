import { route, start } from './ui/router.js';
import { bad } from './ui/toast.js';
import * as dbmod from './state/db.js';

import home from './views/home.js';
import project from './views/project.js';
import settingsView from './views/settings.js';

route('home', home);
route('project', project);
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
    navigator.serviceWorker.register('./sw.js').catch(err => {
      console.warn('service worker 註冊失敗', err);
    });
  }
}

boot();
