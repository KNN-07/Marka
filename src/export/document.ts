import { renderBinary } from "./binary";
import previewCss from "../preview/preview.css?raw";
import katexCss from "../generated/katex.css?raw";
import highlightCss from "highlight.js/styles/github.css?raw";

export type ExportFormat = "pdf" | "docx" | "html" | "txt";
export const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
const encoder = new TextEncoder();
const printCss = `@page { size: A4; margin: 20mm; }
html,body { background:#fff; color:#26323b; }
main { max-width:900px; }
pre { white-space:pre-wrap; overflow-wrap:anywhere; }
table { width:100%; table-layout:fixed; } th,td { overflow-wrap:anywhere; }
img { max-width:100%; height:auto; } h1,h2,h3,h4,h5,h6 { break-after:avoid; }
thead { display:table-header-group; } tr,img { break-inside:avoid; }
.export-tab { margin:1em 0; } .export-tab > h3 { border-bottom:1px solid #dfe6e8; }
@media print { main { max-width:none; padding:0; } body { font-size:11pt; } a { color:inherit; } }
`;

export function limitBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength > MAX_EXPORT_BYTES)
    throw new Error(
      "Export exceeds 64 MiB. Split this document or reduce its images.",
    );
  return bytes;
}

// The input is the sanitized renderer result, never source HTML. Parse only in an
// inert document; neither conversion nor measurement mounts document content.
export function prepareDocument(html: string): HTMLElement {
  if (
    html.length > MAX_EXPORT_BYTES ||
    encoder.encode(html).byteLength > MAX_EXPORT_BYTES
  ) {
    throw new Error("Rendered document exceeds the 64 MiB export limit.");
  }
  const doc = new DOMParser().parseFromString(
    "<!doctype html><html><body></body></html>",
    "text/html",
  );
  const root = doc.createElement("main");
  const template = doc.createElement("template");
  template.innerHTML = html;
  root.append(template.content);
  if (root.querySelectorAll("*").length > 100000)
    throw new Error("Too many elements to export; split this document.");
  root
    .querySelectorAll("script,iframe,object,embed,form,link,meta,style,base")
    .forEach((node) => node.remove());
  for (const element of root.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      if (
        /^on/i.test(attribute.name) ||
        ["srcset", "poster", "background", "action", "formaction"].includes(
          attribute.name,
        )
      )
        element.removeAttribute(attribute.name);
    }
  }
  for (const link of root.querySelectorAll("a")) {
    const href = link.getAttribute("href") ?? "";
    if (href.startsWith("about:srcdoc#"))
      link.setAttribute("href", href.slice("about:srcdoc".length));
    else if (!href.startsWith("#")) link.removeAttribute("href");
  }
  for (const title of root.querySelectorAll(".callout > strong")) {
    const paragraph = doc.createElement("p");
    title.replaceWith(paragraph);
    paragraph.append(title);
  }
  for (const tab of root.querySelectorAll(".mdx-tab")) {
    const panel = tab.querySelector(":scope > .mdx-panel");
    const label = tab.querySelector(":scope > label");
    if (!panel || !label)
      throw new Error(
        "A Tabs panel could not be exported. Correct the component and retry.",
      );
    const section = doc.createElement("section");
    section.className = "export-tab";
    const heading = doc.createElement("h3");
    heading.textContent = label.textContent;
    section.append(heading, ...panel.childNodes);
    tab.replaceWith(section);
  }
  for (const tabs of root.querySelectorAll(".mdx-tabs"))
    tabs.removeAttribute("class");
  for (const checkbox of root.querySelectorAll('input[type="checkbox"]')) {
    checkbox.replaceWith(
      doc.createTextNode(checkbox.hasAttribute("checked") ? "[x] " : "[ ] "),
    );
  }
  root.querySelectorAll("input").forEach((node) => node.remove());
  root
    .querySelectorAll("details")
    .forEach((node) => node.setAttribute("open", ""));
  let total = 0;
  const images = root.querySelectorAll("img");
  if (images.length > 24)
    throw new Error("Export supports at most 24 images and diagrams.");
  for (const image of images) {
    const url = image.getAttribute("src") ?? "";
    if (!/^data:image\/(?:png|jpeg|gif|webp|svg\+xml)(?:;base64)?,/i.test(url))
      throw new Error(
        `Image “${image.alt || "untitled"}” is not embedded. Refresh the preview and retry.`,
      );
    total += url.length;
    if (url.length > 15 * 1024 * 1024 || total > 40 * 1024 * 1024)
      throw new Error(
        "Export image resources are too large. Reduce their size and retry.",
      );
  }
  return root;
}

export function buildExportHtml(title: string, html: string): string {
  const root = prepareDocument(html);
  const escapedTitle = title.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
  const result = `<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; connect-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; object-src 'none'; form-action 'none'; base-uri 'none'"><title>${escapedTitle}</title><style>${previewCss}\n${katexCss}\n${highlightCss}\n${printCss}</style></head><body>${root.outerHTML}</body></html>`;
  limitBytes(encoder.encode(result));
  return result;
}

export interface Run {
  text?: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  image?: string;
  math?: string;
  alt?: string;
}
export interface Paragraph {
  kind: "paragraph";
  runs: Run[];
  heading?: number;
  code?: boolean;
  quote?: boolean;
  marker?: string;
  depth?: number;
}
export interface Table {
  kind: "table";
  rows: Block[][][];
  header: boolean;
}
export type Block = Paragraph | Table;

function inline(node: Node, style: Run = {}): Run[] {
  if (node.nodeType === 3) return [{ ...style, text: node.textContent ?? "" }];
  if (!(node instanceof Element)) return [];
  if (node.classList.contains("katex")) {
    const math = node.querySelector("math");
    const tex = node.querySelector(
      'annotation[encoding="application/x-tex"]',
    )?.textContent;
    if (!math || tex == null)
      throw new Error(
        "An equation is missing its MathML or TeX representation. Correct it and retry.",
      );
    return [{ math: math.outerHTML, alt: tex }];
  }
  if (node.tagName === "IMG")
    return [
      {
        image: node.getAttribute("src")!,
        alt: node.getAttribute("alt") || "Image",
      },
    ];
  if (node.tagName === "BR") return [{ text: "\n" }];
  if (node.classList.contains("sr-only")) return [];
  const next = {
    ...style,
    bold: style.bold || ["STRONG", "B", "TH"].includes(node.tagName),
    italic: style.italic || ["EM", "I"].includes(node.tagName),
    strike: style.strike || ["DEL", "S"].includes(node.tagName),
    code: style.code || node.tagName === "CODE",
  };
  return [...node.childNodes].flatMap((child) => inline(child, next));
}
const blockTags: Record<string, true> = {
  P: true,
  DIV: true,
  SECTION: true,
  ARTICLE: true,
  ASIDE: true,
  HEADER: true,
  FOOTER: true,
  MAIN: true,
  FIELDSET: true,
  DETAILS: true,
  SUMMARY: true,
  BLOCKQUOTE: true,
  UL: true,
  OL: true,
  LI: true,
  TABLE: true,
  PRE: true,
  HR: true,
  H1: true,
  H2: true,
  H3: true,
  H4: true,
  H5: true,
  H6: true,
};
export function documentBlocks(root: Element, depth = 0): Block[] {
  if (depth > 100) throw new Error("Document nesting is too deep to export.");
  const blocks: Block[] = [];
  let pending: Run[] = [];
  const flush = () => {
    if (pending.some((run) => run.image || run.math || run.text?.trim()))
      blocks.push({ kind: "paragraph", runs: pending });
    pending = [];
  };
  for (const node of root.childNodes) {
    if (!(node instanceof Element) || !blockTags[node.tagName]) {
      pending.push(...inline(node));
      continue;
    }
    flush();
    const tag = node.tagName;
    if (
      /^H[1-6]$/.test(tag) ||
      tag === "P" ||
      tag === "SUMMARY" ||
      tag === "PRE"
    ) {
      blocks.push({
        kind: "paragraph",
        runs:
          tag === "PRE"
            ? [{ text: node.textContent ?? "", code: true }]
            : inline(node),
        heading: /^H/.test(tag) ? Number(tag[1]) : undefined,
        code: tag === "PRE",
      });
    } else if (tag === "TABLE") {
      const rows = [...node.querySelectorAll("tr")]
        .filter((row) => row.closest("table") === node)
        .map((row) =>
          [...row.children]
            .filter((cell) => ["TD", "TH"].includes(cell.tagName))
            .map((cell) => documentBlocks(cell, depth + 1)),
        );
      if (rows.length)
        blocks.push({
          kind: "table",
          rows,
          header: !!node.querySelector("tr > th"),
        });
    } else if (tag === "UL" || tag === "OL") {
      let index = Number(node.getAttribute("start") || 1);
      for (const item of [...node.children].filter(
        (child) => child.tagName === "LI",
      )) {
        const children = documentBlocks(item, depth + 1);
        if (!children.length || children[0].kind !== "paragraph")
          children.unshift({ kind: "paragraph", runs: [{ text: "" }] });
        const first = children[0] as Paragraph;
        first.marker = tag === "OL" ? `${index++}.` : "•";
        first.depth = 0;
        for (const child of children.slice(1))
          if (child.kind === "paragraph") child.depth = (child.depth ?? -1) + 1;
        blocks.push(...children);
      }
    } else if (tag === "HR")
      blocks.push({ kind: "paragraph", runs: [{ text: "────────────────" }] });
    else {
      const children = documentBlocks(node, depth + 1);
      if (tag === "BLOCKQUOTE")
        for (const child of children)
          if (child.kind === "paragraph") child.quote = true;
      blocks.push(...children);
    }
  }
  flush();
  return blocks;
}

export function blocksText(blocks: Block[]): string {
  return (
    blocks
      .map((block) => {
        if (block.kind === "table")
          return block.rows
            .map((row) =>
              row
                .map((cell) => blocksText(cell).trim().replace(/\n+/g, " / "))
                .join("\t"),
            )
            .join("\n");
        const prefix = block.heading
          ? `${"#".repeat(block.heading)} `
          : block.marker
            ? `${"  ".repeat(block.depth ?? 0)}${block.marker} `
            : block.quote
              ? "> "
              : "";
        return (
          prefix +
          block.runs
            .map((run) =>
              run.math
                ? `$${run.alt}$`
                : run.image
                  ? `[Image: ${run.alt}]`
                  : (run.text ?? ""),
            )
            .join("")
        );
      })
      .join("\n\n") + "\n"
  );
}

export async function exportDocument(input: {
  format: ExportFormat;
  title: string;
  html: string;
}): Promise<{ bytes: Uint8Array; mime: string; extension: string }> {
  try {
    if (input.format === "html")
      return {
        bytes: limitBytes(
          encoder.encode(buildExportHtml(input.title, input.html)),
        ),
        mime: "text/html;charset=utf-8",
        extension: "html",
      };
    const blocks = documentBlocks(prepareDocument(input.html));
    if (input.format === "txt")
      return {
        bytes: limitBytes(encoder.encode(blocksText(blocks))),
        mime: "text/plain;charset=utf-8",
        extension: "txt",
      };
    return {
      bytes: limitBytes(await renderBinary(input.format, input.title, blocks)),
      mime:
        input.format === "pdf"
          ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      extension: input.format,
    };
  } catch (error) {
    throw new Error(
      `Could not export ${input.format.toUpperCase()}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
