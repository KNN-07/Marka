import { useEffect, useRef, useState } from "react";
import { readAsset } from "../lib/native";
import { resolveImagePath } from "./resources";
import type {
  RenderInput,
  RenderResult,
  ResourceOutput,
  ResourceValue,
  Heading,
  Diagnostic,
  Decoration,
} from "./pipeline";
import { renderMermaid } from "./mermaid";
import previewCss from "./preview.css?raw";
import katexCss from "../generated/katex.css?raw";
import lightHighlight from "highlight.js/styles/github.css?raw";
import darkHighlight from "highlight.js/styles/github-dark.css?raw";
export interface PreviewPaneProps {
  documentId: string;
  version: number;
  format: "md" | "mdx";
  source: string;
  theme: "light" | "dark";
  workspaceId: string | null;
  path: string | null;
  refreshKey: number;
  onResult: (result: {
    headings: Heading[];
    diagnostics: Diagnostic[];
    decorations: Decoration[];
  }) => void;
}
const policy =
  "default-src 'none'; script-src 'none'; connect-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; object-src 'none'; form-action 'none'; base-uri 'none'";
export default function PreviewPane(props: PreviewPaneProps) {
  const [goodPages, setGoodPages] = useState<Map<string, string>>(
    () => new Map(),
  );
  const [status, setStatus] = useState("Preparing preview…");
  const [retry, setRetry] = useState(0);
  const [failed, setFailed] = useState(false);
  const resultCallback = useRef(props.onResult);
  resultCallback.current = props.onResult;
  const cache = useRef<{
    identity: string;
    images: Map<string, { url: string; bytes: number }>;
    diagrams: Map<string, string>;
  }>({ identity: "", images: new Map(), diagrams: new Map() });
  const identity = `${props.documentId}\u0000${props.workspaceId}\u0000${props.path}\u0000${props.refreshKey}`;
  useEffect(() => {
    if (cache.current.identity !== identity)
      cache.current = { identity, images: new Map(), diagrams: new Map() };
    let current = true;
    let worker: Worker | null = null;
    let timer: number | undefined;
    const clearTimer = () => {
      window.clearTimeout(timer);
      timer = undefined;
    };
    const die = (message: string) => {
      if (!current) return;
      clearTimer();
      worker?.terminate();
      worker = null;
      setStatus(message);
      setFailed(true);
      resultCallback.current({
        headings: [],
        decorations: [],
        diagnostics: [
          {
            from: 0,
            to: Math.min(1, props.source.length),
            severity: "error",
            message,
          },
        ],
      });
    };
    const arm = () => {
      clearTimer();
      timer = window.setTimeout(
        () =>
          die(
            "Preview processing exceeded two seconds. Edit the source or choose Retry.",
          ),
        2000,
      );
    };
    setFailed(false);
    setStatus("Updating preview…");
    const debounce = setTimeout(() => {
      if (!current) return;
      worker = new Worker(new URL("./preview.worker.ts", import.meta.url), {
        type: "module",
      });
      worker.onerror = () =>
        die("Preview worker failed. Edit the source or choose Retry.");
      worker.onmessage = async (
        event: MessageEvent<RenderResult | ResourceOutput>,
      ) => {
        const output = event.data;
        if (
          !current ||
          output.documentId !== props.documentId ||
          output.version !== props.version
        )
          return;
        clearTimer();
        if (output.kind === "result") {
          resultCallback.current(output);
          if (output.html !== null) {
            const html = output.html;
            setGoodPages((previous) => {
              const pages = new Map(previous);
              pages.delete(props.documentId);
              pages.set(props.documentId, html);
              let characters = 0;
              for (const page of pages.values()) characters += page.length;
              for (const [id, page] of pages) {
                if (
                  (pages.size <= 20 && characters <= 24 * 1024 * 1024) ||
                  pages.size === 1
                )
                  break;
                pages.delete(id);
                characters -= page.length;
              }
              return pages;
            });
            setStatus(
              output.diagnostics.length
                ? `${output.diagnostics.length} preview warning${output.diagnostics.length === 1 ? "" : "s"}`
                : "",
            );
            setFailed(false);
          } else {
            setStatus(output.diagnostics.map((d) => d.message).join(" "));
            setFailed(true);
          }
          worker?.terminate();
          worker = null;
          return;
        }
        setStatus("Resolving local preview resources…");
        const resources: Record<string, ResourceValue> = {};
        let imageBytes = 0;
        const usedImages = new Set<string>(),
          usedDiagrams = new Set<string>();
        for (const request of output.requests) {
          if (!current) return;
          try {
            if (request.kind === "image") {
              if (!props.workspaceId)
                throw new Error("Local images require a desktop workspace.");
              const path = resolveImagePath(props.path, request.path);
              usedImages.add(path);
              let image = cache.current.images.get(path);
              if (!image) {
                const buffer = await readAsset(props.workspaceId, path);
                if (!current) return;
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
                cache.current.images.set(path, image);
              }
              imageBytes += image.bytes;
              if (imageBytes > 20 * 1024 * 1024)
                throw new Error("Preview images exceed 20 MiB total.");
              resources[request.id] = { url: image.url };
            } else {
              const key = `${props.theme}\u0000${request.source}`;
              usedDiagrams.add(key);
              let url = cache.current.diagrams.get(key);
              if (!url) {
                url = await renderMermaid(
                  request.source,
                  props.theme,
                  () => current,
                );
                if (!current) return;
                cache.current.diagrams.set(key, url);
              }
              resources[request.id] = { url };
            }
          } catch (error) {
            resources[request.id] = {
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }
        if (!current || !worker) return;
        for (const key of cache.current.images.keys())
          if (!usedImages.has(key)) cache.current.images.delete(key);
        for (const key of cache.current.diagrams.keys())
          if (!usedDiagrams.has(key)) cache.current.diagrams.delete(key);
        arm();
        worker.postMessage({
          kind: "resources",
          documentId: props.documentId,
          version: props.version,
          resources,
        });
      };
      arm();
      worker.postMessage({
        kind: "render",
        documentId: props.documentId,
        version: props.version,
        format: props.format,
        source: props.source,
        theme: props.theme,
      } satisfies RenderInput);
    }, 250);
    return () => {
      current = false;
      clearTimeout(debounce);
      clearTimer();
      worker?.terminate();
    };
  }, [
    props.documentId,
    props.version,
    props.format,
    props.source,
    props.theme,
    props.workspaceId,
    props.path,
    identity,
    retry,
  ]);
  const html = goodPages.get(props.documentId) ?? "";
  const css = `${previewCss}\n${katexCss}\n${props.theme === "dark" ? darkHighlight : lightHighlight}`;
  const srcDoc = `<!doctype html><html lang="en" data-theme="${props.theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${policy}"><style>${css}</style></head><body><main>${html}</main></body></html>`;
  return (
    <section
      className="preview-pane"
      aria-label="Rendered preview"
      style={{
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        minHeight: 0,
        height: "100%",
      }}
    >
      {props.format === "mdx" && (
        <div className="preview-help">
          Safe MDX preview: bundled components and literal values only
        </div>
      )}
      {status && (
        <div
          className={`preview-notice ${failed ? "error" : ""}`}
          role={failed ? "alert" : "status"}
        >
          {failed && html
            ? "Stale preview — showing the last valid version. "
            : ""}
          {status}
          {failed && (
            <button
              type="button"
              onClick={() => setRetry((value) => value + 1)}
            >
              Retry
            </button>
          )}
        </div>
      )}
      <iframe
        title="Markdown preview"
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={srcDoc}
        style={{
          border: 0,
          flex: 1,
          width: "100%",
          minHeight: 0,
          background: props.theme === "dark" ? "#191d22" : "#fff",
        }}
      />
    </section>
  );
}
