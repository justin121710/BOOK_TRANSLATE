# 金鑰安全：只有自己用的情況

## 先釐清一件事

**把這個 App 公開部署到 GitHub Pages，不會洩漏你的金鑰。**

金鑰從頭到尾只存在你手機瀏覽器的 localStorage，不在程式碼裡、不在 repo 裡、
不會隨著部署被推上去。別人開你的網址只會看到一個空的設定頁，
必須填他自己的金鑰才能用，費用也算在他頭上。

所以「網站是公開的」和「金鑰會外流」是兩件不相干的事。不需要為了保護金鑰
而放棄部署——放棄部署你就沒辦法在 iPhone 上用了。

---

## 三個真正的風險，按嚴重程度排

### ① 手滑把金鑰寫進程式碼並推上 GitHub

這是唯一會造成真正外流的途徑，而且**公開 repo 上的金鑰通常幾分鐘內就會被爬蟲撿走**。

**已做的防護**：`tools/check-secrets.mjs` 已安裝為 `.git/hooks/pre-commit`，
每次提交前掃描 staged 內容，看到 `AIza…`、`sk-ant-…`、GitHub token 等樣式就擋下來。

手動整包掃一次：

```bash
node tools/check-secrets.mjs --all
```

注意：hook 擋的是**還沒提交**的東西。如果金鑰已經進了 git 歷史，
刪檔案再提交是沒有用的，歷史裡仍然查得到。那種情況唯一正確的處理是
**立刻去 Console 刪掉那把金鑰、重建一把**，而不是嘗試改寫歷史。

### ② 翻譯用的金鑰外流（比 Vision 那把嚴重）

三把鑰匙的風險等級不一樣：

| | Google Vision | Google Gemini | Anthropic Claude |
|---|---|---|---|
| 有無來源限制機制 | **有**（HTTP referrer） | **沒有** | **沒有** |
| 外流後的可用性 | 只能從你指定的網域用 | 任何地方都能用 | 任何地方都能用 |
| 單價 | 每 1000 頁約 US$1.5 | 高出一到兩個數量級 | 高出一到兩個數量級 |

**Gemini 不能和 Vision 共用同一把金鑰**（除非你放棄 Vision 的網站限制）：
Generative Language API 不支援 HTTP referrer 限制，Cloud Console 會直接擋下這個組合，
訊息類似「無法結合目前選取的 API 限制」。所以要分成兩把：

- **Vision 金鑰**：應用程式限制選「網站」，API 限制只勾 Cloud Vision API
- **Gemini 金鑰**：應用程式限制只能選「無」，API 限制只勾 Generative Language API。
  最快的取得方式是 [Google AI Studio](https://aistudio.google.com/apikey)

翻譯用的那把（不論 Gemini 或 Claude）都沒有來源限制可用，
所以**唯一的防線是花費上限與輪替**。

### ③ 別人拿到你解鎖的手機

跟瀏覽器裡存的任何密碼同一類風險。設定頁的金鑰欄位預設是遮蔽的，
但按一下眼睛圖示就看得到。沒有額外的技術手段能改變這點。

---

## 兜底：設上限，讓外流也燒不了多少錢

這比任何「防止外流」的措施都實際。

### Google Cloud：設每日配額上限

1. 到 [Cloud Vision 配額頁](https://console.cloud.google.com/apis/api/vision.googleapis.com/quotas)
2. 找到每分鐘／每日的請求數配額
3. 按編輯，把上限調到你實際會用的量（例如每天 500 頁就設 500）

配額是硬上限，超過直接拒絕，不會繼續產生費用。

### Google Cloud：設預算警示

1. 到 [預算與快訊](https://console.cloud.google.com/billing/budgets)
2. 建立預算，金額設一個你能接受的數字（例如 US$5／月）
3. 勾選 50%／90%／100% 寄信通知

預算警示**只會通知，不會自動停用服務**。真正的硬上限是上面的配額。

### Anthropic：用專屬金鑰並設花費上限

1. 到 [Anthropic Console](https://console.anthropic.com/settings/keys)
2. **為這個 App 單獨建一把金鑰**，不要跟其他用途共用——
   這樣萬一要作廢，不會波及別的東西
3. 在 Workspace 設定裡替它設每月花費上限

---

## 輪替

覺得有一點點可能外流過，就直接刪掉重建。這兩把鑰匙重建都不用一分鐘，
重建後回 App 設定頁貼上新的即可。猶豫的成本遠高於重建的成本。

- Google：[憑證頁面](https://console.cloud.google.com/apis/credentials) → 刪除 → 重新建立 → 記得重設網站限制
- Anthropic：[金鑰頁面](https://console.anthropic.com/settings/keys) → Revoke → Create Key

---

## 網站限制到底要填什麼

```
http://localhost:5173/*
```
```
https://justin121710.github.io/*
```

兩個容易踩的細節：

- **結尾的 `/*` 不能省。** 只寫 `https://justin121710.github.io` 是不會通過的。
- **不要寫帶路徑的樣式。** 跨網域請求在瀏覽器預設的 `strict-origin-when-cross-origin`
  政策下只會送出來源網域、不含路徑，所以 Google 收到的是 `https://justin121710.github.io/`。
  寫成 `https://justin121710.github.io/BOOK_TRANSLATE/*` 反而匹配不到，請求會被擋。

最後，誠實說一句：referrer 限制擋得住隨手撿到金鑰就拿去用的人，
擋不住刻意偽造 Referer 標頭的人。它降低風險而不是消除風險，
所以上面的配額上限才是真正的兜底。
