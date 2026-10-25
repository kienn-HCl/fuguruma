// Copies pdf.js character maps, standard fonts, image decoders (wasm) and
// colour profiles into public/ so the viewer can render CJK PDFs and embedded
// images. Runs before dev/build.
import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = dirname(require.resolve("pdfjs-dist/package.json"));
const out = new URL("../public/pdfjs/", import.meta.url).pathname;
for (const d of ["cmaps", "standard_fonts", "wasm", "iccs"]) cpSync(join(root, d), join(out, d), { recursive: true });
