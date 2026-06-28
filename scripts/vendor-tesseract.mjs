/**
 * vendor-tesseract.mjs — copy the Tesseract.js runtime assets into public/ so OCR
 * runs FULLY ON-DEVICE and OFFLINE (no CDN at recognition time).
 *
 * Why this exists: tesseract.js fetches its worker, WASM core, and language data
 * from a CDN by default. The service worker only caches SAME-ORIGIN requests, so
 * CDN assets would break offline use. We vendor everything under public/tesseract/
 * (same-origin → static-served → SW-cached) and point ocr.js at those paths.
 *
 * What it copies (from node_modules, version-locked to the installed tesseract.js):
 *   - worker.min.js                        the worker thread script
 *   - tesseract-core-simd-lstm.wasm.js     the LSTM (OEM 1) core, SIMD build,
 *                                          self-contained (embeds its own .wasm)
 *
 * NOT copied here (binary, committed to the repo): the language data
 *   public/tesseract/lang/eng.traineddata.gz
 * which is gzipped tessdata_fast `eng` (small, tuned for printed text). To refresh:
 *   curl -fsSL https://github.com/tesseract-ocr/tessdata_fast/raw/4.1.0/eng.traineddata -o eng.traineddata
 *   gzip -c eng.traineddata > public/tesseract/lang/eng.traineddata.gz
 *
 * Run after `npm install` (wired as the `vendor:ocr` script). Idempotent.
 */
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'public', 'tesseract');
mkdirSync(join(dest, 'lang'), { recursive: true });

const copies = [
  ['node_modules/tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'],
];

for (const [from, to] of copies) {
  const src = join(root, from);
  if (!existsSync(src)) {
    console.error(`vendor-tesseract: missing ${from} — run "npm install" first.`);
    process.exit(1);
  }
  copyFileSync(src, join(dest, to));
  console.log(`vendor-tesseract: ${to}`);
}

if (!existsSync(join(dest, 'lang', 'eng.traineddata.gz'))) {
  console.warn('vendor-tesseract: WARNING public/tesseract/lang/eng.traineddata.gz is missing — see header comment to fetch it (offline OCR will not work without it).');
}
console.log('vendor-tesseract: done.');
