import { readAsset } from "../lib/native";
import { resolveImagePath } from "./resources";
import { renderMermaid } from "./mermaid";
import type {
  RenderInput,
  RenderResult,
  ResourceOutput,
  ResourceValue,
} from "./pipeline";

export type RenderCache = {
  images: Map<string, { url: string; bytes: number }>;
  diagrams: Map<string, string>;
};

/** Render one immutable source snapshot. Preview and export use the same safety boundary. */
export function renderDocument(
  input: RenderInput,
  options: {
    workspaceId: string | null;
    path: string | null;
    signal: AbortSignal;
    cache?: RenderCache;
  },
): Promise<RenderResult> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) {
      reject(new DOMException("Rendering canceled", "AbortError"));
      return;
    }
    const cache = options.cache ?? { images: new Map(), diagrams: new Map() };
    const worker = new Worker(new URL("./preview.worker.ts", import.meta.url), {
      type: "module",
    });
    let active = true;
    let timer: number | undefined;
    const cleanup = () => {
      active = false;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      worker.terminate();
    };
    const fail = (error: Error) => {
      if (!active) return;
      cleanup();
      reject(error);
    };
    const abort = () =>
      fail(new DOMException("Rendering canceled", "AbortError"));
    const arm = () => {
      clearTimeout(timer);
      timer = window.setTimeout(
        () =>
          fail(
            new Error(
              "Preview processing exceeded two seconds. Edit the source or choose Retry.",
            ),
          ),
        2000,
      );
    };
    options.signal.addEventListener("abort", abort, { once: true });
    worker.onerror = () =>
      fail(
        new Error("Preview worker failed. Edit the source or choose Retry."),
      );
    worker.onmessage = async (
      event: MessageEvent<RenderResult | ResourceOutput>,
    ) => {
      const output = event.data;
      if (
        !active ||
        output.documentId !== input.documentId ||
        output.version !== input.version
      )
        return;
      clearTimeout(timer);
      if (output.kind === "result") {
        cleanup();
        resolve(output);
        return;
      }
      const resources: Record<string, ResourceValue> = {};
      let imageBytes = 0;
      const usedImages = new Set<string>();
      const usedDiagrams = new Set<string>();
      for (const request of output.requests) {
        if (!active) return;
        try {
          if (request.kind === "image") {
            if (!options.workspaceId)
              throw new Error("Local images require a desktop workspace.");
            const path = resolveImagePath(options.path, request.path);
            usedImages.add(path);
            let image = cache.images.get(path);
            if (!image) {
              const buffer = await readAsset(options.workspaceId, path);
              if (!active) return;
              if (
                buffer.byteLength > 10 * 1024 * 1024 ||
                imageBytes + buffer.byteLength > 20 * 1024 * 1024
              )
                throw new Error(
                  "Preview images exceed the 10 MiB per image / 20 MiB total limit.",
                );
              const bytes = new Uint8Array(buffer);
              const extension = path.split(".").pop()!.toLowerCase();
              const mime =
                extension === "jpg" || extension === "jpeg"
                  ? "jpeg"
                  : extension;
              let binary = "";
              for (let offset = 0; offset < bytes.length; offset += 32768)
                binary += String.fromCharCode(
                  ...bytes.subarray(offset, offset + 32768),
                );
              image = {
                url: `data:image/${mime};base64,${btoa(binary)}`,
                bytes: buffer.byteLength,
              };
              cache.images.set(path, image);
            }
            imageBytes += image.bytes;
            if (imageBytes > 20 * 1024 * 1024)
              throw new Error("Preview images exceed 20 MiB total.");
            resources[request.id] = { url: image.url };
          } else {
            const key = `${input.theme}\u0000${request.source}`;
            usedDiagrams.add(key);
            let url = cache.diagrams.get(key);
            if (!url) {
              url = await renderMermaid(
                request.source,
                input.theme,
                () => active,
              );
              if (!active) return;
              cache.diagrams.set(key, url);
            }
            resources[request.id] = { url };
          }
        } catch (error) {
          resources[request.id] = {
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
      if (!active) return;
      for (const key of cache.images.keys())
        if (!usedImages.has(key)) cache.images.delete(key);
      for (const key of cache.diagrams.keys())
        if (!usedDiagrams.has(key)) cache.diagrams.delete(key);
      arm();
      worker.postMessage({
        kind: "resources",
        documentId: input.documentId,
        version: input.version,
        resources,
      });
    };
    arm();
    worker.postMessage(input);
  });
}
