import { useEffect, useRef, useState } from "react";
import type { Heading, Diagnostic, Decoration } from "./pipeline";
import { renderDocument, type RenderCache } from "./render";
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
  const [status, setStatus] = useState("");
  const [retry, setRetry] = useState(0);
  const [failed, setFailed] = useState(false);
  const resultCallback = useRef(props.onResult);
  resultCallback.current = props.onResult;
  const cache = useRef<RenderCache & { identity: string }>({
    identity: "",
    images: new Map(),
    diagrams: new Map(),
  });
  const identity = `${props.documentId}\u0000${props.workspaceId}\u0000${props.path}\u0000${props.refreshKey}`;
  useEffect(() => {
    if (cache.current.identity !== identity)
      cache.current = { identity, images: new Map(), diagrams: new Map() };
    const controller = new AbortController();
    setFailed(false);
    setStatus("");
    const debounce = setTimeout(() => {
      void renderDocument(
        {
          kind: "render",
          documentId: props.documentId,
          version: props.version,
          format: props.format,
          source: props.source,
          theme: props.theme,
        },
        {
          workspaceId: props.workspaceId,
          path: props.path,
          signal: controller.signal,
          cache: cache.current,
        },
      )
        .then((output) => {
          if (controller.signal.aborted) return;
          resultCallback.current(output);
          if (output.html === null) {
            setStatus(
              output.diagnostics
                .map((diagnostic) => diagnostic.message)
                .join(" "),
            );
            setFailed(true);
            return;
          }
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
        })
        .catch((error: Error) => {
          if (controller.signal.aborted) return;
          setStatus(error.message);
          setFailed(true);
          resultCallback.current({
            headings: [],
            decorations: [],
            diagnostics: [
              {
                from: 0,
                to: Math.min(1, props.source.length),
                severity: "error",
                message: error.message,
              },
            ],
          });
        });
    }, 250);
    return () => {
      clearTimeout(debounce);
      controller.abort();
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
