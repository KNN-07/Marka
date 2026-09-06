import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
export default defineConfig({
  plugins: [react()],
  // MathJax's browser build constant avoids its Node-only eval-based version lookup.
  define: {
    PACKAGE_VERSION: JSON.stringify(
      require("mathjax-full/package.json").version,
    ),
  },
  // Browser exports use DOM APIs unavailable to the preview worker.
  resolve: {
    alias: {
      "decode-named-character-reference": fileURLToPath(
        import.meta.resolve("decode-named-character-reference"),
      ),
      "hast-util-from-html-isomorphic": fileURLToPath(
        import.meta.resolve("hast-util-from-html-isomorphic"),
      ),
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        print: fileURLToPath(new URL("./print.html", import.meta.url)),
      },
    },
  },
  server: { host: "localhost", port: 1420, strictPort: true },
  clearScreen: false,
});
