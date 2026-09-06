import { createRequire } from "node:module";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, extname } from "node:path";
const require = createRequire(import.meta.url);
const cssPath = require.resolve("katex/dist/katex.min.css");
let css = await readFile(cssPath, "utf8");
const mime = {
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};
const urls = [
  ...new Set([...css.matchAll(/url\(([^)]+)\)/g)].map((match) => match[1])),
];
for (const raw of urls) {
  const path = raw.replace(/^["']|["']$/g, "");
  const type = mime[extname(path)];
  if (!type || /^(?:[a-z]+:|\/)/i.test(path))
    throw new Error(`Unsupported KaTeX font URL: ${path}`);
  const bytes = await readFile(resolve(dirname(cssPath), path));
  css = css.replaceAll(
    `url(${raw})`,
    `url(data:${type};base64,${bytes.toString("base64")})`,
  );
}
const output = new URL("../src/generated/", import.meta.url);
await mkdir(output, { recursive: true });
await writeFile(new URL("katex.css", output), css);
console.log("Prepared offline KaTeX CSS and fonts.");
