// 画像・PDFの取り込み。結果は {blob, width, height} の配列（保存は呼び出し側）。
export class ImportError extends Error {}

const MAX_PIXELS = 4_000_000;       // 4.5 大きい写真はここまで縮小する
const PDF_PAGE_WIDTH = 1600;        // 4.6 PDFは横幅約1600pxのJPEGにする
const PDF_MAX_HEIGHT = 8000;
const PDF_BASE = new URL('../lib/pdfjs/', import.meta.url);

const nextFrame = () => new Promise((r) => setTimeout(r, 0));
const toBlob = (canvas, type, q) => new Promise((resolve, reject) => {
  canvas.toBlob((b) => (b ? resolve(b) : reject(new ImportError('画像の変換に失敗しました。メモリが足りない可能性があります。'))), type, q);
});

async function imageToPage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      throw new ImportError(`「${file.name}」は読み込めません。この端末のブラウザで表示できない形式（HEICなど）の可能性があります。JPEGやPNGに変えてからお試しください。`);
    }
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) throw new ImportError(`「${file.name}」は画像として読み込めませんでした。`);
    if (w * h <= MAX_PIXELS) {
      return { blob: file.slice(0, file.size, file.type), width: w, height: h };
    }
    const scale = Math.sqrt(MAX_PIXELS / (w * h));
    const cw = Math.round(w * scale), ch = Math.round(h * scale);
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    canvas.getContext('2d').drawImage(img, 0, 0, cw, ch);
    const blob = await toBlob(canvas, 'image/jpeg', 0.9);
    canvas.width = canvas.height = 0;
    return { blob, width: cw, height: ch };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function importImages(files, onProgress = () => {}) {
  const pages = [];
  for (let i = 0; i < files.length; i++) {
    onProgress(i, files.length);
    await nextFrame();
    pages.push(await imageToPage(files[i]));
  }
  onProgress(files.length, files.length);
  return pages;
}

let pdfjsPromise;
function loadPdfjs() {
  pdfjsPromise ||= import('../lib/pdfjs/pdf.min.mjs').then((m) => {
    m.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', PDF_BASE).href;
    return m;
  }).catch(() => {
    pdfjsPromise = null;
    throw new ImportError('PDFを読み込む部品を開けませんでした。お使いのブラウザが古い可能性があります。文字と画像は使えます。');
  });
  return pdfjsPromise;
}

export async function importPdf(file, onProgress = () => {}) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({
    data,
    cMapUrl: new URL('cmaps/', PDF_BASE).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('standard_fonts/', PDF_BASE).href,
    wasmUrl: new URL('wasm/', PDF_BASE).href,
    iccUrl: new URL('iccs/', PDF_BASE).href,
  });
  let pdf;
  try {
    pdf = await task.promise;
  } catch (e) {
    if (e?.name === 'PasswordException') throw new ImportError(`「${file.name}」はパスワード付きのPDFのため読み込めません。パスワードを外してからお試しください。`);
    if (e?.name === 'InvalidPDFException') throw new ImportError(`「${file.name}」は壊れているか、PDFではありません。`);
    throw new ImportError(`「${file.name}」を読み込めませんでした。（${e?.message || e}）`);
  }
  const pages = [];
  try {
    for (let n = 1; n <= pdf.numPages; n++) {
      onProgress(n - 1, pdf.numPages);
      await nextFrame();
      const page = await pdf.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(PDF_PAGE_WIDTH / base.width, PDF_MAX_HEIGHT / base.height);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      const blob = await toBlob(canvas, 'image/jpeg', 0.85);
      pages.push({ blob, width: canvas.width, height: canvas.height });
      canvas.width = canvas.height = 0;
      page.cleanup();
    }
  } catch (e) {
    if (e instanceof ImportError) throw e;
    throw new ImportError(`PDFの${pages.length + 1}ページ目の変換に失敗しました。（${e?.message || e}）`);
  } finally {
    await task.destroy();
  }
  onProgress(pages.length, pages.length);
  return pages;
}
