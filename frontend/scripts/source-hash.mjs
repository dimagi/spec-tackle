// Record which source the bundle was built from; tests/test_frontend_bundle.py checks it.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = new URL("..", import.meta.url).pathname;
// Keep in sync with tests/test_frontend_bundle.py.
const INPUTS = ["index.html", "package-lock.json", "vite.config.ts", "tsconfig.json"];

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

const rel = (path) => relative(root, path).split(sep).join("/");
const files = walk(join(root, "src")).sort((a, b) => (rel(a) < rel(b) ? -1 : 1));
files.push(...INPUTS.map((name) => join(root, name)));

const digest = createHash("sha256");
for (const path of files) {
  digest.update(Buffer.concat([Buffer.from(rel(path)), Buffer.from([0])]));
  digest.update(Buffer.concat([readFileSync(path), Buffer.from([0])]));
}
writeFileSync(join(root, "../src/spec_tackle/static/dist/.source-hash"), digest.digest("hex") + "\n");
