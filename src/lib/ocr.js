/**
 * ocr.js — the thin, isolated seam over Tesseract.js for on-device OCR.
 *
 * HARD INVARIANT (extends CLAUDE.md): a lab-slip photo is the most identifying
 * artifact in the app (printed name + ID). OCR runs FULLY ON-DEVICE. The image
 * bytes NEVER leave the phone and are NEVER persisted:
 *   · Tesseract is loaded lazily and configured with LOCAL asset paths only
 *     (public/tesseract/*) — no CDN, so nothing about the image touches the
 *     network. The only outbound clinical call in the app remains parser.cloudParse,
 *     which receives DE-IDENTIFIED TEXT, never an image.
 *   · This module takes a Blob, returns the recognized TEXT, and terminates the
 *     worker — it holds no reference to the image after returning. Callers must
 *     treat the image as transient (drop it after handoff) and route the returned
 *     text through the SAME intake pipeline (de-identify → parse → review → commit).
 *     OCR text is UNVERIFIED input; it gets no shortcut to commit.
 *
 * Kept deliberately thin so main.js stays glue. The Tesseract call itself isn't
 * unit-tested; the wrapper isolation is the point.
 */

// Local, same-origin asset paths (vendored by scripts/vendor-tesseract.mjs). These
// keep recognition offline: the service worker caches same-origin GETs, so once the
// assets have loaded they are available with no network. We force the SIMD LSTM core
// (OEM 1) as a single self-contained file rather than letting Tesseract pick a
// variant from the CDN — SIMD is universally supported on modern mobile browsers.
const WORKER_PATH = '/tesseract/worker.min.js';
const CORE_PATH = '/tesseract/tesseract-core-simd-lstm.wasm.js';
const LANG_PATH = '/tesseract/lang';

/**
 * Recognize printed text in an image Blob, fully on-device.
 * @param {Blob} imageBlob  the photo bytes (transient — never persisted/sent)
 * @param {{ onProgress?: (fraction:number) => void }} [opts]
 * @returns {Promise<string>} the recognized text (unverified — review downstream)
 */
export async function recognize(imageBlob, { onProgress } = {}) {
  // Lazy import: this pulls the Tesseract chunk only when the user actually snaps
  // a photo, so the main bundle stays small and the app boots/works without it.
  const { createWorker } = await import('tesseract.js');

  const worker = await createWorker('eng', 1, {
    workerPath: WORKER_PATH,
    corePath: CORE_PATH,
    langPath: LANG_PATH,
    // gzip:true (default) → fetches eng.traineddata.gz from LANG_PATH.
    logger: (m) => {
      if (onProgress && m && m.status === 'recognizing text' && typeof m.progress === 'number') {
        onProgress(m.progress);
      }
    },
  });

  try {
    const { data } = await worker.recognize(imageBlob);
    return (data && data.text) ? data.text.trim() : '';
  } finally {
    // Terminate so no worker (and no decoded image) lingers in memory.
    await worker.terminate();
  }
}
