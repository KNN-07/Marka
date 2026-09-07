import { build } from "esbuild";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(resolve(root, "src/generated"), { recursive: true });
// Only this fixed application entry is bundled. Document/plugin input never reaches Node/esbuild.
await build({
  absWorkingDir: root,
  entryPoints: ["src/mdx/sandbox.tsx"],
  outfile: "src/generated/mdx-sandbox.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  sourcemap: false,
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "trusted-raw-css",
      setup(build) {
        build.onResolve({ filter: /\.css\?raw$/ }, async (args) => {
          const resolved = await build.resolve(args.path.slice(0, -4), {
            resolveDir: args.resolveDir,
            kind: args.kind,
          });
          return resolved.errors.length
            ? { errors: resolved.errors }
            : { path: resolved.path, namespace: "raw-css" };
        });
        build.onLoad({ filter: /.*/, namespace: "raw-css" }, async (args) => ({
          contents: await readFile(args.path, "utf8"),
          loader: "text",
          resolveDir: dirname(args.path),
        }));
      },
    },
  ],
});
console.log(
  "Prepared isolated classic MDX runtime (React, MDXProvider, offline diagrams and styles).",
);
