import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig({
  plugins: [react()],
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
  server: { host: "localhost", port: 1420, strictPort: true },
  clearScreen: false,
});
