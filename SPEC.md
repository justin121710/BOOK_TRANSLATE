# BOOK_TRANSLATE — 日文書籍排版還原翻譯器

把日文書頁掃描進來，OCR 出文字與座標，用 Claude 翻成繁體中文，再依照原書排版（含直排）重建成一份全新的 PDF。

---

## 1. 已定案規格

| 項目 | 決定 |
|---|---|
| 平台 | **PWA**（手機瀏覽器，加到主畫面）。無 Mac，原生 iOS 不可行 |
| 輸入 | 相機拍實體書 / 匯入 PDF / 相簿選照片 / EPUB |
| OCR | **Google Cloud Vision** `DOCUMENT_TEXT_DETECTION`（使用者自帶金鑰） |
| 翻譯 | **Claude API**（使用者自帶金鑰） |
| 語言對 | 日文 → 繁體中文 |
| 輸出 | **真・空白 PDF 重排**：文字塊重排回原座標，圖片裁切貼回原位 |
| 直排 | **完整還原**，含右→左欄序 |
| 圖片 | 原樣裁切貼回；圖內日文翻譯以註解形式列在圖旁／頁尾，不修圖 |
| 溢框 | **字級自動縮放，框線固定**（8%–100% 二分搜尋） |
| 振り仮名 | 偵測後丟棄 |
| 頁眉／頁碼／側標 | 從原圖裁切貼回（影像，非文字），不送翻譯 |
| 註釋號／註解／引用 | 一併翻譯 |
| 專有名詞 | 建全書詞彙表，跨頁統一譯法 |
| 規模 | 單次數頁～數十頁 |
| 字型 | 內文思源宋體 Noto Serif TC，標題思源黑體 Noto Sans TC，子集化嵌入 |
| 譯文修正 | 不手打；可針對單一文字塊「重跑」，可附一句指示 |
| 匯出 | 預設純中譯；匯出對話框可勾選「附原頁對照」 |
| 程式碼 | 多檔 ES modules，無建置步驟，GitHub Pages 直接伺服 |

---

## 2. 規格衝突與處置

以下四點是你的選擇彼此打架、或物理上做不到的地方。我採取的處置寫在後面。

### 衝突 1 — EPUB 沒有排版座標

EPUB 是 reflowable HTML，檔案裡**根本不存在「原頁面座標」**。它的頁是閱讀器當下算出來的，不是書的屬性。所以「照原排版貼回空白 PDF」對 EPUB 在定義上就不成立。

**處置**：EPUB 走獨立路徑。解析章節 → 翻譯 → 用一套統一的書籍版式（直排、固定天地左右邊距、每頁行數與字數）生成排版乾淨的新 PDF。這產出的是「一本排得很好看的中譯書」，不是「還原原排版」。EPUB 分頁與原書分頁不會一致。若你要的其實是還原，EPUB 這個輸入應該砍掉。

### 衝突 2 — 相機拍照必然有透視變形

手持拍書一定有梯形變形與書脊彎曲。OCR 回傳的座標是**變形後**的座標，直接搬進平面 PDF 會整頁歪斜、行距不均，「照原排版」會很難看。

**處置**：拍照後強制進入透視校正步驟，使用者拖四個角，做 homography 重投影成正矩形，校正後的影像才送 OCR。書脊彎曲只做輕度補償（沿彎曲方向的分段拉伸）；書脊嚴重彎曲的內側頁建議壓平再拍，UI 會提示。

### 衝突 3 — Google Vision 不會告訴你「哪裡有圖」

它只回傳文字與文字座標。「圖片在哪」必須自己從「非文字區域」反推，而這是啟發式，一定會誤判：大片留白會被當成圖、跨過圖片的文字會把圖切成碎塊。

**處置**：自動偵測（文字遮罩 → 剩餘區域邊緣密度 → 連通元件 → 面積與長寬比過濾）產生候選圖框，**並在預覽頁讓使用者手動框選新增或刪除**。純自動不可靠，這個手動關卡不能省。

### 衝突 4 — 「不手打修正」＋「振り仮名丟棄」有救不回來的風險

若振り仮名判定誤殺了真正的內文小字（例如小字排版的註解、對白），使用者沒有手打能力就無法救回。

**處置**：重跑對話框裡一律顯示 **OCR 讀到的原始日文**，讓使用者看得出是翻錯還是 OCR 就錯了；並提供「附加指示」欄（例如「這是人名」「保留所有小字」「這塊是直排」）與「不丟棄 ruby 重跑此塊」的開關。仍不手打，但給得回救援手段。

---

## 3. 處理管線

```
輸入 → 前處理 → OCR → 版面分析 → 翻譯 → 排版重建 → PDF 輸出
```

### 3.1 輸入層 `src/input/`

- **camera.js** — `<input type="file" accept="image/*" capture="environment">`，iOS Safari 直開相機
- **photos.js** — `accept="image/*" multiple`，批次選圖
- **pdfin.js** — pdf.js 逐頁 render 成 canvas。**若該 PDF 帶原生文字層**（`getTextContent()` 有內容），直接取用 glyph 級精確座標，完全跳過 OCR ── 這是品質最高、成本為零的路徑
- **epubin.js** — JSZip 解包 → OPF spine → XHTML，走衝突 1 的獨立路徑

### 3.2 前處理 `src/preprocess/`

- **deskew.js** — 使用者拖四角 → 3×3 homography → canvas 重投影
- **shadow.js** — 灰階 → 大核模糊當背景估計 → 除法正規化去陰影
- 二值化僅供 OCR 使用；**貼回 PDF 的圖片一律用原始彩色影像**

### 3.3 OCR `src/ocr/`

- **google-vision.js** — `POST https://vision.googleapis.com/v1/images:annotate?key=…`
  - feature `DOCUMENT_TEXT_DETECTION`，`imageContext.languageHints: ["ja"]`
  - 回傳 `fullTextAnnotation`：page → block → paragraph → word → symbol，每層都有 4 頂點 boundingBox
  - symbol 上的 `property.detectedBreak` 提供斷行資訊
- **native-text.js** — PDF 原生文字層的等價輸出，與上面同一份資料結構

**直排偵測**：block 內同一 paragraph 的 words 若 x 中心變異小而 y 單調遞增，且 block 高寬比 > 1.5 → 判為直排。
**欄序**：直排時 blocks 依 x 中心**由大到小**排序（右→左）；橫排時依 y 再依 x。

### 3.4 版面分析 `src/layout/`

- **ruby.js** — 振り仮名剔除。條件：字高 < 同 block 中位字高 × 0.6，且緊貼另一 word 的右側（直排）或上方（橫排），且內容全為假名
- **classify.js** — 把 blocks 的文字與正規化座標送 Claude，分類為 `title / body / caption / header / footer / pagenum / sidebar / note / table`。`header / footer / pagenum` 標記為不翻譯
- **figures.js** — 圖片區域偵測（衝突 3 的啟發式）＋ 使用者手動框選介面

### 3.5 翻譯 `src/translate/`

- **claude.js** — `POST https://api.anthropic.com/v1/messages`
  - headers：`x-api-key`、`anthropic-version: 2023-06-01`、`anthropic-dangerous-direct-browser-access: true`
  - 模型可選 `claude-opus-5`（品質）／ `claude-sonnet-5`（成本）
  - 一次送整頁 blocks 的 JSON 陣列，要求回傳同 id 對應的譯文陣列
- **glossary.js** — 專有名詞表。每頁請求的 system prompt 帶入現有詞表；回應附帶「本頁新出現的專有名詞」，累積寫回 IndexedDB

翻譯指示的核心約束：忠於原文、僅微幅調整為自然中文語法、**不增譯、不刪譯、不加註解說明**。

### 3.6 排版重建 `src/render/`

- **horizontal.js** — 框內左→右自動換行
- **vertical.js** — 直排引擎（本專案最大工作量）
  - 逐字定位：從框右上角起向下排，一欄滿了往左移一欄
  - **標點旋轉**：`ー 〜 … （） 「」 『』 〔〕 ——` 旋轉 90°
  - **標點位移**：`。、` 置於字格右上
  - **縦中横**：連續 2 位半形數字組成橫向小組
  - **禁則**：行首禁 `。、」）』`（前推）；行尾禁 `「（『`（後推）
- **fit.js** — 字級二分搜尋，在 `[0.08, 1.0] × 原字高` 區間找最大可容納值

### 3.7 PDF 輸出 `src/pdf/`

字型路線經過實測，結果如下（可用 `_scratch/pdftest.html` 重跑整條瀏覽器端管線）：

| 路徑 | 結果 |
|---|---|
| pdf-lib `embedFont(bytes, {subset:true})` + CFF/OTF | **壞** — pdf.js 報 `Invalid font data in ArrayBuffer`，漢字大量掉字 |
| pdf-lib `subset:true` + 可變 TTF | **壞** — 產出 9KB 的無效字型，完全不渲染 |
| harfbuzz 子集 + CFF/OTF | **壞** — 整頁只剩豆腐框 |
| **harfbuzz 子集（`pin_all_axes_to_default`）+ 可變 TTF → pdf-lib `subset:false`** | **可用** — 16MB → 20KB，40ms，字形與文字層皆正確 |

**定案**：
- 字型檔用 google/fonts 的**可變 TTF**（`NotoSerifTC[wght].ttf` 9.7MB、`NotoSansTC[wght].ttf` 6.7MB），CFF/OTF 路線整條放棄
- 子集化由 **harfbuzzjs**（`hb-subset.wasm`，約 300KB）負責，把可變軸定格成 wght=400 的靜態實例
- pdf-lib 只負責嵌入，`subset: false`，**絕對不要讓 pdf-lib 自己去子集化 CJK 字型**
- 字型原始檔首次下載約 **16.4 MB**，存 IndexedDB 快取。UI 必須有明確的下載進度與體積提示

**字符覆蓋限制（實測）**：Noto Serif TC 對繁中漢字與日文假名覆蓋 100%，但**缺日文專用新字體漢字**（實測 19 字中缺 9 字：静桜峠渋変読対応帰）。影響與處置：

- 譯文是繁體中文 → 不受影響
- **「頁眉／頁碼／側標保留不翻譯」會受影響** → 改為**從原始掃描影像裁切該區域貼回**，不走文字渲染。這同時更符合「保留原樣」的字面意思，且完全繞開缺字問題
- 譯文中若殘留日文專用漢字（罕見的人名地名）→ 渲染前做字符覆蓋檢查，缺字時在預覽頁標示出來讓使用者用單塊重跑處理

其餘：
- 圖片：從原頁 canvas 裁切該矩形 → JPEG → `embedJpg` → 畫回同座標
- 匯出選項：純中譯 ／ 附原頁對照（奇數頁原掃描、偶數頁中譯）

### 3.8 狀態與韌性 `src/state/`

- IndexedDB 存頁面影像、OCR 結果、分類、譯文、詞彙表 → 關掉分頁不會全毀
- Wake Lock API 防止手機休眠中斷批次處理
- 每頁獨立狀態（待處理／OCR中／翻譯中／完成／失敗），失敗可單頁重試

---

## 4. 金鑰與隱私

- 兩組金鑰（Google Vision、Claude）存在瀏覽器 localStorage，**不上傳任何伺服器**
- 頁面影像會傳送到 Google Cloud Vision；文字會傳送到 Anthropic。UI 首次啟動明確告知
- Google Vision 金鑰在瀏覽器端呼叫時會出現在請求 URL 中。設定頁會提示：請在 Google Cloud Console 對該金鑰設定 **HTTP referrer 限制**，只允許本 App 的網域

---

## 5. 開發階段

| 階段 | 內容 |
|---|---|
| M1 | 專案骨架、PWA 殼、設定頁、金鑰管理、IndexedDB |
| M2 | 輸入層（相機／相簿／PDF）＋ 透視校正 |
| M3 | Google Vision 串接、直排偵測、欄序、ruby 剔除 |
| M4 | Claude 翻譯、區塊分類、詞彙表 |
| M5 | **直排排版引擎**（最大工作量） |
| M6 | 圖片區偵測與手動框選、PDF 輸出、字型子集化 |
| M7 | 預覽比對頁、單塊重跑、匯出選項 |
| M8 | EPUB 路徑（衝突 1 的獨立管線） |

---

## 6. 已知環境限制

- 開發機為 Windows，**無 Mac、無 Xcode**，因此不做原生 iOS，也無法在 iOS Safari 上由我直接驗證。我可在桌面瀏覽器驗證，iOS 實機測試需由你執行
- 本機**未安裝 `gh` CLI**。推上 GitHub Pages 時，需你先建立 repo，或先安裝 `gh` 由我代為建立
