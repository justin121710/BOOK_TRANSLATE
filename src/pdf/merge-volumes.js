import { PDFContext, PDFCrossRefSection, PDFDocument, PDFHeader, PDFName, PDFObjectCopier, PDFRef } from 'pdf-lib';

const PDF_TYPE = 'application/pdf';
const CHUNK_BYTES = 4 * 1024 * 1024;

export async function mergeVolumes(volumes, { signal, onProgress } = {}) {
  if (volumes.length < 2) throw new Error('至少需要兩冊 PDF');
  const encoder = new TextEncoder();
  const entries = [];
  const catalogRef = PDFRef.of(1);
  const treeRef = PDFRef.of(2);
  const children = [];
  const chunks = [];
  let pending = [];
  let pendingBytes = 0;
  let offset = 0;
  let lastObject = treeRef.objectNumber;

  function flush() {
    if (!pendingBytes) return;
    chunks.push(new Blob(pending));
    pending = [];
    pendingBytes = 0;
  }

  function append(bytes) {
    pending.push(bytes);
    pendingBytes += bytes.byteLength;
    offset += bytes.byteLength;
  }

  function writeObject(ref, object) {
    if (offset > 9_999_999_999) throw new Error('整本 PDF 超過可合併的大小上限');
    entries.push({ ref, offset });
    const size = object.sizeInBytes();
    if (pendingBytes + size > CHUNK_BYTES) flush();
    append(encoder.encode(`${ref.objectNumber} ${ref.generationNumber} obj\n`));
    const bytes = new Uint8Array(size);
    const written = object.copyBytesInto(bytes, 0);
    append(bytes.subarray(0, written));
    append(encoder.encode('\nendobj\n'));
    if (pendingBytes >= CHUNK_BYTES) flush();
  }

  const header = PDFHeader.forVersion(1, 7);
  const headerBytes = new Uint8Array(header.sizeInBytes());
  header.copyBytesInto(headerBytes, 0);
  append(headerBytes);
  append(encoder.encode('\n'));
  const pageCount = volumes.at(-1).range.total;

  let nextPage = 1;
  for (const [index, volume] of volumes.entries()) {
    signal?.throwIfAborted();
    onProgress?.(index + 1, volumes.length);
    const { range, result } = volume;
    if (range.from !== nextPage || range.total !== pageCount || range.to < range.from) {
      throw new Error('分冊頁碼不連續');
    }
    await appendVolume(result.blob, range.to - range.from + 1);
    nextPage = range.to + 1;
    flush();
  }
  if (nextPage !== pageCount + 1) throw new Error('分冊頁碼不完整');
  signal?.throwIfAborted();
  const root = PDFContext.create();
  writeObject(catalogRef, root.obj({ Type: 'Catalog', Pages: treeRef }));
  writeObject(treeRef, root.obj({ Type: 'Pages', Count: pageCount, Kids: children }));
  flush();

  const xrefOffset = offset;
  const xref = PDFCrossRefSection.create();
  entries.sort((a, b) => a.ref.objectNumber - b.ref.objectNumber);
  for (const entry of entries) xref.addEntry(entry.ref, entry.offset);
  const xrefBytes = new Uint8Array(xref.sizeInBytes());
  xref.copyBytesInto(xrefBytes, 0);
  const trailer = `\ntrailer\n<< /Size ${lastObject + 1} /Root ${catalogRef} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new Blob([...chunks, xrefBytes, trailer], { type: PDF_TYPE });

  async function appendVolume(blob, expectedPages) {
    const source = await PDFDocument.load(await blob.arrayBuffer(), { updateMetadata: false });
    const pages = source.getPages();
    if (pages.length !== expectedPages) throw new Error('分冊檔案的頁數與記錄不符');
    const dest = PDFContext.create();
    dest.largestObjectNumber = lastObject;
    const copier = PDFObjectCopier.for(source.context, dest);
    for (const page of pages) {
      const ref = copier.copy(page.ref);
      dest.lookup(ref).set(PDFName.of('Parent'), treeRef);
      children.push(ref);
    }
    for (const [index, [ref, object]] of dest.enumerateIndirectObjects().entries()) {
      signal?.throwIfAborted();
      writeObject(ref, object);
      if (index % 32 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    lastObject = dest.largestObjectNumber;
  }
}
