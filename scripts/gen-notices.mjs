// Generates THIRD_PARTY_NOTICES.md: licenses of everything shipped in the
// fuguruma binary (Go modules linked into it, npm packages bundled into the
// embedded frontend, and the pdf.js character maps / standard fonts).
//
// Usage: node scripts/gen-notices.mjs   (run from the repository root, after `npm ci` in web/)
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
// Plain code-point order so the output is identical on every machine (CI checks it).
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const licenseFile = /^(LICEN[CS]E|COPYING|NOTICE)([.-](md|markdown|txt|mit))?$/i;

function licenseTexts(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => licenseFile.test(f))
    .sort()
    .map((f) => ({ file: f, text: readFileSync(join(dir, f), "utf8").trim() }));
}

function mitText(holder) {
  return `Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
}

// ---- Go modules linked into the binary ----
const goOut = execFileSync(
  "go",
  ["list", "-deps", "-f", "{{with .Module}}{{if not .Main}}{{.Path}}\t{{.Version}}\t{{.Dir}}{{end}}{{end}}", "./cmd/fuguruma"],
  { cwd: root, encoding: "utf8" },
);
const goMods = new Map();
for (const line of goOut.split("\n").filter(Boolean)) {
  const [path, version, dir] = line.split("\t");
  goMods.set(path, { name: path, version, texts: licenseTexts(dir) });
}

// ---- npm packages bundled into the frontend (non-dev dependencies) ----
const lock = JSON.parse(readFileSync(join(root, "web/package-lock.json"), "utf8"));
const npmPkgs = [];
for (const [key, meta] of Object.entries(lock.packages)) {
  // Skip dev tooling, optional native add-ons (pdf.js' Node-only canvas) and type-only packages.
  if (!key.startsWith("node_modules/") || meta.dev || meta.devOptional || meta.optional) continue;
  const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
  if (name.startsWith("@types/")) continue;
  const dir = join(root, "web", key);
  let texts = licenseTexts(dir);
  if (texts.length === 0 && meta.license === "MIT") {
    // Some small packages declare MIT in package.json without shipping a LICENSE file.
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const author = typeof pkg.author === "string" ? pkg.author : pkg.author?.name ?? `the ${name} authors`;
    texts = [{ file: "MIT (declared in package.json; no license file in the package)", text: mitText(author) }];
  }
  npmPkgs.push({ name, version: meta.version, license: meta.license ?? "", texts });
}
npmPkgs.sort(byName);

// ---- pdf.js data files copied into the frontend ----
const pdfjs = join(root, "web/node_modules/pdfjs-dist");
// Every LICENSE* file in a data directory (some hold one per bundled component).
const allLicenses = (dir) =>
  readdirSync(join(pdfjs, dir))
    .filter((f) => f.startsWith("LICENSE"))
    .sort()
    .map((f) => ({ file: f, text: readFileSync(join(pdfjs, dir, f), "utf8").trim() }));
const extras = [
  { name: "pdf.js character maps (pdfjs-dist/cmaps)", texts: licenseTexts(join(pdfjs, "cmaps")) },
  { name: "pdf.js standard fonts (pdfjs-dist/standard_fonts)", texts: allLicenses("standard_fonts") },
  { name: "pdf.js image decoders and colour management (pdfjs-dist/wasm)", texts: allLicenses("wasm") },
  { name: "pdf.js colour profiles (pdfjs-dist/iccs)", texts: allLicenses("iccs") },
];

const missing = [...goMods.values(), ...npmPkgs, ...extras].filter((p) => p.texts.length === 0);
if (missing.length) {
  console.error("No license file found for:\n" + missing.map((p) => `  ${p.name}`).join("\n"));
  process.exit(1);
}

const section = (p) =>
  `### ${p.name}${p.version ? ` ${p.version}` : ""}\n\n` +
  p.texts.map((t) => `<details><summary>${t.file}</summary>\n\n\`\`\`\n${t.text}\n\`\`\`\n\n</details>\n`).join("\n");

const out = `# Third-party notices

Fuguruma is released under the MIT License (see [LICENSE](LICENSE)). The
fuguruma binary also contains the third-party software listed below, each
under its own license.

This file is generated by \`scripts/gen-notices.mjs\` (\`make notices\`). Do not edit it by hand.

## Frontend (npm packages bundled into the web UI)

| Package | Version | License |
|---|---|---|
${npmPkgs.map((p) => `| ${p.name} | ${p.version} | ${p.license} |`).join("\n")}

The text layer styles in \`web/src/reader/textlayer.css\` are copied from
pdfjs-dist (\`web/pdf_viewer.css\`) and are covered by its Apache-2.0 license below.

## Go modules linked into the binary

| Module | Version |
|---|---|
${[...goMods.values()].sort(byName).map((p) => `| ${p.name} | ${p.version} |`).join("\n")}

## License texts

${[...npmPkgs, ...extras, ...[...goMods.values()].sort(byName)].map(section).join("\n")}`;

writeFileSync(join(root, "THIRD_PARTY_NOTICES.md"), out);
console.log(`THIRD_PARTY_NOTICES.md: ${npmPkgs.length} npm packages, ${goMods.size} Go modules, ${extras.length} data sets`);
