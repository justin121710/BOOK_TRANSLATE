# 書籍翻譯器 BOOK_TRANSLATE

把日文書頁掃描進來，OCR 出文字與版面座標，用 Claude 翻成繁體中文，
再依照原書排版（含直排、右→左欄序）重建成一份全新的 PDF。

行動優先的 PWA，用 Safari 開啟後「分享 → 加到主畫面」就會變成 iPhone 上的 App。

完整規格、技術決策與已知衝突請見 **[SPEC.md](SPEC.md)**。

---

## 開發

```bash
node tools/serve.mjs
```

開 <http://localhost:5173>。無建置步驟，直接 ES modules。

重新產生 PWA 圖示：

```bash
node tools/make-icons.mjs
```

### 開發時的快取陷阱

Service worker 與瀏覽器的模組快取都會讓你改了程式碼卻看到舊版。
`tools/serve.mjs` 已經送 `cache-control: no-store`，但模組圖仍可能被沿用。
改完看不到效果時，用帶 query 的網址重新載入，例如 `http://localhost:5173/?v=2`。

---

## 目前進度

| 里程碑 | 狀態 |
|---|---|
| M1 專案骨架、PWA 殼、金鑰管理、IndexedDB | ✅ 完成 |
| M2 輸入層（相機／相簿／PDF）＋ 透視校正 | ✅ 完成 |
| M3 Google Vision OCR、直排偵測、ruby 剔除 | ✅ 完成 |
| M4 Claude 翻譯、區塊分類、全書詞彙表 | ✅ 完成 |
| M5 直排排版引擎 | ✅ 完成（引擎與測試；接進 PDF 在 M6、接進預覽在 M7） |
| M6 圖片區偵測、PDF 輸出、字型子集化 | ✅ 完成 |
| M7 預覽比對、單塊重跑、匯出選項 | ⬜ |
| M8 EPUB 獨立路徑 | ⬜ |

### 已知瑕疵

- 直排的連續破折號 `——` 中間會有一道細縫。兩個字元各自旋轉，
  而破折號的字面寬不滿一個字身，接縫就露出來了。需要把連續的破折號
  合併成單一繪製單元才能根治。

M1 附帶已驗證的字型管線（`src/pdf/fonts.js`）：
16MB 可變 TTF → harfbuzz 子集化 → pdf-lib 嵌入，實測在瀏覽器內
子集化 253ms、產生 PDF 61ms，直排逐字定位與標點旋轉皆正常。

M2 的透視校正走 WebGL 逐像素反向 homography（`src/preprocess/warp.js`），
實測空白紙面接縫跳變率 0.00%、校正 20ms。PDF 匯入會自動偵測原生文字層，
有的話直接取用 glyph 級座標，完全跳過 OCR 也不產生 Vision 費用。

---

## 目錄

```
index.html                App 殼與 <template> 視圖
manifest.webmanifest      PWA manifest
sw.js                     service worker（殼快取；API 一律不快取）
css/app.css               全部樣式，色彩集中在 :root
src/
  main.js                 進入點、路由註冊、全域錯誤處理
  state/db.js             IndexedDB：頁面、文字塊、圖框、詞彙表、字型
  state/settings.js       金鑰與偏好（localStorage）
  ui/router.js            hash 路由
  ui/toast.js             浮動提示
  ui/dialog.js            自製對話框（不用 window.prompt/confirm）
  ui/cropper.js           四角校正編輯器（含放大鏡）
  input/pages.js          頁面建立與衍生影像
  input/pdfin.js          PDF 匯入與原生文字層抽取
  ocr/parse.js            Vision 回應 → 文字塊（純函式，可用固定樣本測）
  ocr/native.js           PDF 原生文字層 → 同一種文字塊形狀
  ocr/index.js            單頁與批次辨識、疊圖繪製
  translate/prompt.js     翻譯指令、結構化輸出 schema、費用估算
  translate/glossary.js   全書專有名詞對照表
  translate/index.js      單頁與批次翻譯、單塊重跑
  render/rules.js         直排字元規則：旋轉、標點位移、縦中横、禁則
  render/layout.js        排版計算，只算座標不畫圖（預覽與 PDF 共用）
  render/canvas.js        用 canvas 畫出排版結果，給預覽用
  preprocess/warp.js      透視校正（WebGL 為主、網格法備援）
  preprocess/enhance.js   縮放、去陰影、編碼
  api/vision.js           Google Cloud Vision
  api/claude.js           Anthropic Claude
  pdf/fonts.js            字型下載、快取、harfbuzz 子集化、缺字檢查
  pdf/figures.js          圖片區偵測（啟發式，需人工確認）與裁切
  pdf/export.js           產生成品 PDF
  views/                  home / project / page / settings
tools/serve.mjs           開發伺服器
tools/make-icons.mjs      圖示產生器
_scratch/pdftest.html     瀏覽器端 PDF 產出驗證頁
_scratch/warptest.html    透視校正驗證頁（含接縫量測）
_scratch/ocrtest.html     OCR 解析的固定樣本測試（26 項，不花 API 額度）
_scratch/translatetest.html 翻譯流程測試（攔截 fetch 回傳預錄回應，不花 API 額度）
_scratch/layouttest.html  直排排版測試（含標點位置的放大視覺檢視）
_scratch/exporttest.html  端到端匯出測試：造假頁 → 偵測圖片 → 產生 PDF → 讀回驗證
```

---

## 使用前要準備

兩組自帶的 API 金鑰，在 App 的設定頁填入，只存在本機瀏覽器：

1. **Google Cloud Vision** — OCR 與版面座標。
   取得與鎖定金鑰的完整步驟見 **[docs/google-vision-setup.md](docs/google-vision-setup.md)**。
2. **Anthropic Claude** — 翻譯與版面語意判讀。
   到 [Anthropic Console](https://console.anthropic.com/settings/keys) 建立金鑰。

金鑰只存在你這台裝置的瀏覽器 localStorage，不會進入 repo，也不會上傳到任何伺服器。
`tools/check-secrets.mjs` 會在每次 commit 前掃描，擋住手滑把金鑰寫進程式碼的情況
（已安裝為 `.git/hooks/pre-commit`）。

風險評估、配額上限與輪替方式見 **[docs/api-keys-safety.md](docs/api-keys-safety.md)**。

首次匯出 PDF 前要在設定頁下載中文字型，兩套合計約 17 MB（下載一次後快取）。

---

## 部署

推到 GitHub Pages 即可，沒有建置步驟。本機尚未安裝 `gh` CLI，
建立 repo 與首次推送需要手動處理。
