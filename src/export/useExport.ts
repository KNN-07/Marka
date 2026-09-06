import { useEffect, useRef, useState } from "react";
import * as native from "../lib/native";
import { renderDocument } from "../preview/render";
import type { DocumentTab } from "../workspace/types";
import { buildExportHtml, exportDocument, type ExportFormat } from "./document";

export function useExport(
  getDocument: () => DocumentTab | null,
  workspaceId: string | null,
  notify: (message: string) => void,
) {
  const [busy, setBusy] = useState(false);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), [workspaceId]);

  const run = async (format: ExportFormat | "print") => {
    const tab = getDocument();
    if (!tab || operation.current) return;
    if (format === "print" && !native.nativeAvailable) {
      notify(
        "Native printing is available in the desktop app. You can export HTML or PDF in this browser.",
      );
      return;
    }
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    const title = tab.title.replace(/\.(md|markdown|mdx)$/i, "") || "Untitled";
    // Capture the authoritative buffer now, not the debounced or last-good preview.
    const source = tab.state.doc.toString();
    try {
      const rendered = await renderDocument(
        {
          kind: "render",
          documentId: tab.id,
          version: tab.generation,
          format: tab.format,
          source,
          theme: "light",
        },
        { workspaceId, path: tab.path, signal: controller.signal },
      );
      if (rendered.html === null)
        throw new Error(
          `Cannot ${format === "print" ? "print" : "export"} this document: ${rendered.diagnostics.map((issue) => issue.message).join(" ")}`,
        );
      if (controller.signal.aborted) return;
      const warning = rendered.diagnostics.length
        ? ` (${rendered.diagnostics.length} rendering warning(s); affected content is marked)`
        : "";
      if (format === "print") {
        await native.openPrintDocument(
          title,
          buildExportHtml(title, rendered.html),
        );
        if (!controller.signal.aborted)
          notify(
            `Print view opened for ${title}${warning}. Choose Print in that window.`,
          );
      } else {
        const result = await exportDocument({
          format,
          title,
          html: rendered.html,
        });
        if (controller.signal.aborted) return;
        if (native.nativeAvailable) {
          const saved = await native.saveExport(format, title, result.bytes);
          if (saved && !controller.signal.aborted)
            notify(
              `Exported ${format.toUpperCase()} copy${warning}. Your source document is unchanged.`,
            );
        } else {
          const blob = new Blob([result.bytes as Uint8Array<ArrayBuffer>], {
            type: result.mime,
          });
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = `${title.replace(/[\\/:*?"<>|]/g, "-")}.${result.extension}`;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 30_000);
          notify(`Download prepared: ${link.download}${warning}.`);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted)
        notify(error instanceof Error ? error.message : String(error));
    } finally {
      if (operation.current === controller) {
        operation.current = null;
        setBusy(false);
      }
    }
  };
  return { busy, run };
}
