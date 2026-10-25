import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };

/** Opens a PDF using HTTP range requests so only the needed parts are fetched. */
export function openPdf(url: string) {
  return pdfjs.getDocument({
    url,
    disableAutoFetch: true,
    disableStream: true,
    rangeChunkSize: 256 * 1024,
    // Character maps are required for many CJK (e.g. Japanese) PDFs.
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
    // Decoders for JPEG 2000 / JBIG2 images and colour profiles.
    wasmUrl: "/pdfjs/wasm/",
    iccUrl: "/pdfjs/iccs/",
  }).promise;
}

/** Renders page 1 to a JPEG blob, used as the cover for PDFs. */
export async function renderPdfCover(url: string, width = 360): Promise<Blob> {
  const doc = await openPdf(url);
  try {
    const page = await doc.getPage(1);
    const vp1 = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / vp1.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, viewport }).promise;
    return await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob"))), "image/jpeg", 0.85));
  } finally {
    doc.loadingTask.destroy();
  }
}
