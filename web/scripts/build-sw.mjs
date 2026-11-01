// Writes dist/sw.js from sw/sw.js with the list of built files to precache and a
// version derived from their contents (so each build installs a new worker).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const dist = new URL("../dist/", import.meta.url).pathname;
const files = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else files.push(relative(dist, p));
  }
};
walk(dist);
const built = files.filter((f) => f !== "sw.js" && f !== ".gitkeep" && !f.endsWith(".map")).sort();

const hash = createHash("sha256");
for (const f of built) hash.update(f).update(readFileSync(join(dist, f)));

const precache = built
  .map((f) => "/" + f.split("\\").join("/"))
  // The server redirects /index.html to /, and redirected responses cannot be served to pages.
  .map((u) => (u === "/index.html" ? "/" : u));
const version = hash.digest("hex").slice(0, 12);

const src = readFileSync(new URL("../sw/sw.js", import.meta.url), "utf8");
writeFileSync(join(dist, "sw.js"), `const VERSION = ${JSON.stringify(version)};\nconst PRECACHE = ${JSON.stringify(precache)};\n${src}`);
console.log(`sw.js: ${precache.length} files, version ${version}`);
