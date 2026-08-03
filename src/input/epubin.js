/* EPUB 解析。
 *
 * 這條路和其他輸入來源本質不同，見 SPEC.md 衝突 1：
 * EPUB 是可重排的 HTML，檔案裡**不存在原始頁面座標** ——
 * 它的「頁」是閱讀器當下算出來的，不是書的屬性。
 * 所以「照原排版貼回空白 PDF」對 EPUB 在定義上就不成立。
 *
 * 這裡做的是：抽出章節與段落，交給翻譯，再用一套統一的書籍版式重新分頁。
 * 產出的是一本排得乾淨的中譯書，分頁不會和原書一致。
 */

import JSZip from 'jszip';

/**
 * @typedef {object} EpubChapter
 * @property {string} title
 * @property {{kind: string, text: string, indent: boolean}[]} paragraphs
 */

export async function parseEpub(file) {
  const zip = await JSZip.loadAsync(file);

  const opfPath = await findOpf(zip);
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const opfXml = parseXml(await zip.file(opfPath).async('string'));

  const meta = readMetadata(opfXml);

  // manifest：id → 檔案路徑
  const manifest = new Map();
  for (const item of opfXml.querySelectorAll('manifest > item')) {
    manifest.set(item.getAttribute('id'), {
      href: resolvePath(opfDir, item.getAttribute('href')),
      type: item.getAttribute('media-type'),
    });
  }

  // spine 決定閱讀順序，不能照 manifest 的順序讀
  const spine = [];
  for (const ref of opfXml.querySelectorAll('spine > itemref')) {
    const item = manifest.get(ref.getAttribute('idref'));
    if (item && /xhtml|html/.test(item.type || '')) spine.push(item.href);
  }
  if (!spine.length) throw new Error('這個 EPUB 沒有可讀的章節（spine 是空的）');

  const chapters = [];
  for (const href of spine) {
    const f = zip.file(href);
    if (!f) continue;
    const chapter = extractChapter(await f.async('string'), href);
    if (chapter.paragraphs.length) chapters.push(chapter);
  }

  return { ...meta, chapters };
}

/* ---------- 容器與中繼資料 ---------- */

async function findOpf(zip) {
  const container = zip.file('META-INF/container.xml');
  if (!container) throw new Error('這不是有效的 EPUB（缺少 META-INF/container.xml）');
  const xml = parseXml(await container.async('string'));
  const path = xml.querySelector('rootfile')?.getAttribute('full-path');
  if (!path || !zip.file(path)) throw new Error('這個 EPUB 的目錄檔（OPF）找不到');
  return path;
}

function readMetadata(opf) {
  const pick = (tag) => {
    // EPUB 的 metadata 用 Dublin Core 命名空間，querySelector 對命名空間前綴很挑
    const el = opf.querySelector(`metadata > ${tag}`) ||
               [...opf.querySelectorAll('metadata > *')]
                 .find(n => n.localName === tag);
    return el?.textContent?.trim() || '';
  };
  return {
    title: pick('title') || '未命名書籍',
    creator: pick('creator'),
    language: pick('language'),
  };
}

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('EPUB 內的 XML 格式有誤');
  return doc;
}

const resolvePath = (dir, href) => {
  const raw = decodeURIComponent(String(href || '').split('#')[0]);
  if (!dir) return raw;
  // 處理 ../ 之類的相對路徑
  const parts = (dir + raw).split('/');
  const out = [];
  for (const p of parts) {
    if (p === '.' || p === '') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
};

/* ---------- 章節內容 ---------- */

const BLOCK_TAGS = 'h1,h2,h3,h4,h5,h6,p,blockquote,li,figcaption,div.caption,td';

function extractChapter(html, href) {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // 版權宣告、頁首頁尾之類的東西丟掉，它們不是內文
  for (const el of doc.querySelectorAll('script,style,nav,rt,rp')) el.remove();
  // rt / rp 是振り仮名的標記，直接移除就等同規格要求的「丟棄振り仮名」

  const title =
    doc.querySelector('h1,h2,h3')?.textContent?.trim() ||
    doc.querySelector('title')?.textContent?.trim() ||
    href.split('/').pop();

  const paragraphs = [];
  const seen = new Set();

  for (const el of doc.body?.querySelectorAll(BLOCK_TAGS) || []) {
    // 巢狀的區塊元素會被抓兩次，只留最內層的
    if ([...el.querySelectorAll(BLOCK_TAGS)].length) continue;

    const text = el.textContent.replace(/\s+/g, ' ').trim();
    if (!text) continue;

    const key = el.tagName + '|' + text;
    if (seen.has(key)) continue;
    seen.add(key);

    const kind = classify(el);
    paragraphs.push({
      kind,
      text,
      // EPUB 的縮排通常靠 CSS，抓不到；中文書慣例是每段都縮，所以正文一律縮
      indent: kind === 'body' || kind === 'quote',
    });
  }

  return { title, paragraphs, href };
}

/**
 * 判斷一個區塊元素的類型。
 *
 * 要往上看祖先，不能只看自己：blockquote 裡通常還包著 p，
 * 而「只取最內層」的規則會讓那個 p 被當成一般正文，引文的身分就丟了。
 */
function classify(el) {
  if (/^H[1-6]$/.test(el.tagName)) return 'title';
  if (el.tagName === 'FIGCAPTION') return 'caption';
  if (el.tagName === 'TD') return 'table';

  for (let n = el; n && n.tagName !== 'BODY'; n = n.parentElement) {
    if (n.tagName === 'BLOCKQUOTE') return 'quote';
    if (n.tagName === 'FIGCAPTION') return 'caption';
    if (n.tagName === 'FIGURE') return 'caption';
    if (n.tagName === 'TABLE') return 'table';
    const cls = n.getAttribute?.('class') || '';
    if (/caption|figcap/i.test(cls)) return 'caption';
    if (/note|annotation|footnote/i.test(cls)) return 'note';
  }
  return 'body';
}

/** 概覽，給匯入前的確認對話框用。 */
export function summarise(book) {
  const paras = book.chapters.reduce((s, c) => s + c.paragraphs.length, 0);
  const chars = book.chapters.reduce(
    (s, c) => s + c.paragraphs.reduce((t, p) => t + p.text.length, 0), 0);
  return { chapters: book.chapters.length, paragraphs: paras, chars };
}
