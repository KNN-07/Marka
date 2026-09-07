import { safeImagePath } from "./resources";
import { safeExternalUrl } from "./externalLinks";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import remarkMath from "remark-math";
import remarkMdx from "remark-mdx";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeStringify from "rehype-stringify";
import { toString } from "mdast-util-to-string";
import { common, createLowlight } from "lowlight";
import type { Position } from "unist";
import type { Nodes as MdNodes } from "mdast";
import type { Root, Element, Nodes } from "hast";
import type { Schema } from "hast-util-sanitize";
import { VFile } from "vfile";
import {
  componentHandler,
  element,
  text,
  range,
  semanticTags,
  validateMdx,
  type SyntaxNode,
  type Diagnostic,
  type Decoration,
} from "./components";
export type { Diagnostic, Decoration } from "./components";
declare module "mdast" {
  interface RootContentMap {
    markaDiagram: { type: "markaDiagram"; value: string; position?: Position };
  }
}
export type Heading = { id: string; text: string; depth: number; from: number };
export type RenderInput = {
  kind: "render";
  documentId: string;
  version: number;
  format: "md" | "mdx";
  source: string;
  theme: "light" | "dark";
  guardExternalLinks?: boolean;
};
export type ResourceRequest =
  | { id: string; kind: "image"; path: string }
  | { id: string; kind: "mermaid"; source: string; from: number; to: number };
export type ResourceValue = { url: string } | { error: string };
export type ResourcesInput = {
  kind: "resources";
  documentId: string;
  version: number;
  resources: Record<string, ResourceValue>;
};
export type RenderResult = {
  kind: "result";
  documentId: string;
  version: number;
  html: string | null;
  headings: Heading[];
  diagnostics: Diagnostic[];
  decorations: Decoration[];
};
export type ResourceOutput = {
  kind: "requests";
  documentId: string;
  version: number;
  requests: ResourceRequest[];
};
export type PendingRender = {
  input: RenderInput;
  tree: Root;
  requests: ResourceRequest[];
  targets: Map<
    string,
    { node: Element; source?: string; from: number; to: number }
  >;
  headings: Heading[];
  diagnostics: Diagnostic[];
  decorations: Decoration[];
};
const languages = createLowlight(common);
const schema: Schema = {
  tagNames: [...semanticTags, "input", "aside", "fieldset", "legend", "label"],
  // GFM/raw checkboxes already carry disabled; generated radios must remain operable.
  required: { input: {} },
  attributes: {
    "*": [
      "title",
      "lang",
      "dir",
      "id",
      [
        "className",
        /^language-/,
        "math-inline",
        "math-display",
        "no-highlight",
        "sr-only",
        "callout",
        "callout-info",
        "callout-tip",
        "callout-warning",
        "callout-danger",
        "badge",
        "badge-neutral",
        "badge-info",
        "badge-success",
        "badge-warning",
        "mdx-tabs",
        "mdx-tab",
        "mdx-panel",
        "task-list-item",
        "contains-task-list",
        "footnotes",
        "data-footnote-backref",
      ],
    ],
    a: [
      "href",
      "ariaDescribedBy",
      "ariaLabel",
      "dataFootnoteRef",
      "dataFootnoteBackref",
    ],
    img: ["src", "alt", "width", "height"],
    input: [["type", "radio", "checkbox"], "name", "checked", "disabled"],
    label: ["htmlFor"],
    ol: ["start"],
    li: ["value"],
    td: ["align", "colSpan", "rowSpan"],
    th: ["align", "colSpan", "rowSpan"],
    details: ["open"],
    section: ["dataFootnotes"],
  },
  clobber: ["id", "name"],
  clobberPrefix: "marka-",
  protocols: { href: ["http", "https"], src: [] },
  strip: ["script", "style", "iframe", "object", "embed", "form"],
};
function walk(node: Nodes, action: (node: Element) => void) {
  if (node.type === "element") action(node);
  if ("children" in node)
    for (const child of node.children) walk(child, action);
}
export function failedResult(input: RenderInput, error: unknown): RenderResult {
  const issue = error as {
    message?: string;
    line?: number;
    column?: number;
    place?: { offset?: number };
    position?: { start?: { offset?: number } };
  };
  const from =
    issue.place?.offset ??
    issue.position?.start?.offset ??
    (issue.line
      ? input.source
          .split("\n")
          .slice(0, issue.line - 1)
          .reduce((n, line) => n + line.length + 1, 0) +
        (issue.column ?? 1) -
        1
      : 0);
  return {
    kind: "result",
    documentId: input.documentId,
    version: input.version,
    html: null,
    headings: [],
    decorations: [],
    diagnostics: [
      {
        from,
        to: Math.min(input.source.length, from + 1),
        severity: "error",
        message: issue.message ?? String(error),
      },
    ],
  };
}
export async function prepareRender(
  input: RenderInput,
): Promise<PendingRender | RenderResult> {
  try {
    if (new TextEncoder().encode(input.source).length > 5 * 1024 * 1024)
      throw new Error("Preview source exceeds 5 MiB.");
    const parser = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkFrontmatter, ["yaml"])
      .use(remarkMath);
    if (input.format === "mdx") parser.use(remarkMdx);
    const md = parser.parse(input.source);
    const diagnostics: Diagnostic[] = [],
      decorations: Decoration[] = [],
      headings: Heading[] = [];
    const rawRanges: { from: number; to: number }[] = [];
    let count = 0;
    function bound(node: SyntaxNode, depth: number) {
      if (++count > 100000 || depth > 100)
        throw new Error("Preview exceeds the 100,000 node or depth 100 limit.");
      if (node.type === "html") rawRanges.push(range(node));
      for (const child of node.children ?? []) bound(child, depth + 1);
    }
    // Both interfaces describe parser-produced mdast; JSX extensions are checked below.
    const syntax = md as unknown as SyntaxNode;
    bound(syntax, 0);
    if (input.format === "mdx") validateMdx(syntax, diagnostics, decorations);
    if (diagnostics.some((d) => d.severity === "error"))
      return {
        kind: "result",
        documentId: input.documentId,
        version: input.version,
        html: null,
        headings,
        diagnostics,
        decorations,
      };
    const requests: ResourceRequest[] = [],
      targets = new Map<
        string,
        { node: Element; source?: string; from: number; to: number }
      >();
    const diagramNodes = new Map<
      string,
      { source: string; from: number; to: number }
    >();
    let sequence = 0;
    const nextId = () => `generated-${++sequence}`;
    const headingCounts = new Map<string, number>();
    const headingIds = new Set<string>();
    function annotate(node: SyntaxNode) {
      if (node.type === "heading") {
        const title = toString(node as unknown as MdNodes);
        const base =
          title
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s-]/gu, "")
            .trim()
            .replace(/\s+/g, "-") || "heading";
        let count = headingCounts.get(base) ?? 0;
        let id = `heading-${base}${count ? `-${count + 1}` : ""}`;
        while (headingIds.has(id)) {
          count++;
          id = `heading-${base}-${count + 1}`;
        }
        headingCounts.set(base, count + 1);
        headingIds.add(id);
        node.data = { ...node.data, hProperties: { id } };
        headings.push({
          id: `marka-${id}`,
          text: title,
          depth: node.depth ?? 1,
          from: range(node).from,
        });
      }
      if (node.type === "code" && node.lang?.toLowerCase() === "mermaid") {
        const id = nextId();
        diagramNodes.set(id, { source: node.value ?? "", ...range(node) });
        node.type = "markaDiagram";
        node.value = id;
      }
      for (const child of node.children ?? []) annotate(child);
    }
    annotate(syntax);
    const converter = unified().use(remarkRehype, {
      allowDangerousHtml: input.format === "md",
      clobberPrefix: "footnote-",
      handlers: {
        yaml: () => undefined,
        mdxFlowExpression: (_state, node: SyntaxNode) =>
          text(
            typeof node.safeValue === "string" ||
              typeof node.safeValue === "number"
              ? String(node.safeValue)
              : "",
          ),
        mdxTextExpression: (_state, node: SyntaxNode) =>
          text(
            typeof node.safeValue === "string" ||
              typeof node.safeValue === "number"
              ? String(node.safeValue)
              : "",
          ),
        mdxJsxFlowElement: (state, node: SyntaxNode) =>
          componentHandler((n) => state.all(n as unknown as MdNodes), nextId)(
            state,
            node,
          ),
        mdxJsxTextElement: (state, node: SyntaxNode) =>
          componentHandler((n) => state.all(n as unknown as MdNodes), nextId)(
            state,
            node,
          ),
        markaDiagram: (_state: unknown, rawNode: unknown) => {
          const node = rawNode as SyntaxNode;
          return element("pre", { id: node.value }, [
            text(diagramNodes.get(node.value ?? "")?.source ?? ""),
          ]);
        },
      },
    });
    let tree = (await converter.run(md)) as unknown as Root;
    if (input.format === "md")
      tree = (await unified().use(rehypeRaw).run(tree)) as Root;
    walk(tree, (node) => {
      const start = node.position?.start.offset;
      if (
        start !== undefined &&
        rawRanges.some((r) => start >= r.from && start < r.to)
      ) {
        for (const key of Object.keys(node.properties))
          if (
            [
              "id",
              "name",
              "className",
              "style",
              "htmlFor",
              "dataFootnoteRef",
              "dataFootnoteBackref",
              "ariaDescribedBy",
            ].includes(key) ||
            /^on/i.test(key)
          )
            delete node.properties[key];
        if (node.tagName === "input")
          node.properties = {
            type: "checkbox",
            disabled: true,
            checked: !!node.properties.checked,
          };
      }
      if (node.tagName === "a") {
        const href = node.properties.href;
        if (typeof href !== "string") delete node.properties.href;
        else if (!href.startsWith("#")) {
          const external = safeExternalUrl(href);
          if (external) node.properties.href = external;
          else delete node.properties.href;
        }
      }
      if (node.tagName === "img") delete node.properties.srcSet;
    });
    tree = (await unified().use(rehypeSanitize, schema).run(tree)) as Root;
    const ids = new Set<string>();
    walk(tree, (node) => {
      if (typeof node.properties.id === "string") ids.add(node.properties.id);
    });
    let images = 0,
      diagrams = 0;
    walk(tree, (node) => {
      if (
        node.tagName === "a" &&
        typeof node.properties.href === "string" &&
        node.properties.href.startsWith("#")
      ) {
        let raw = node.properties.href.slice(1);
        try {
          raw = decodeURIComponent(raw);
        } catch {
          /* Invalid escapes cannot match generated IDs. */
        }
        const id = [raw, `marka-${raw}`, `marka-heading-${raw}`].find(
          (candidate) => ids.has(candidate),
        );
        if (id) node.properties.href = `about:srcdoc#${id}`;
        else delete node.properties.href;
      } else if (
        input.guardExternalLinks &&
        node.tagName === "a" &&
        typeof node.properties.href === "string"
      ) {
        node.properties.dataMarkaUrl = node.properties.href;
        delete node.properties.href;
        node.properties.role = "link";
        node.properties.tabIndex = 0;
        const hint = "Ctrl/Cmd+click or Ctrl/Cmd+Enter to open in your browser";
        node.properties.title = node.properties.title
          ? `${node.properties.title} — ${hint}`
          : hint;
      }
      for (const prop of ["htmlFor", "ariaDescribedBy"]) {
        const value = node.properties[prop];
        if (typeof value === "string")
          node.properties[prop] = ids.has(value) ? value : `marka-${value}`;
        else if (Array.isArray(value))
          node.properties[prop] = value.map((v) =>
            ids.has(String(v)) ? String(v) : `marka-${v}`,
          );
      }
      const diagram = diagramNodes.get(
        String(node.properties.id ?? "").replace(/^marka-/, ""),
      );
      if (diagram) {
        const id = nextId();
        targets.set(id, { node, ...diagram });
        if (++diagrams > 8 || diagram.source.length > 10000) {
          localError(
            node,
            diagram.source,
            "Diagram exceeds the 8 diagram / 10,000 character limit.",
          );
          diagnostics.push({
            ...diagram,
            severity: "warning",
            message: "Diagram limit exceeded.",
          });
        } else requests.push({ id, kind: "mermaid", ...diagram });
      }
      if (node.tagName === "img") {
        const path = String(node.properties.src ?? "");
        delete node.properties.src;
        const position = {
          from: node.position?.start.offset ?? 0,
          to: node.position?.end.offset ?? 1,
        };
        if (!safeImagePath(path) || ++images > 16) {
          const message =
            "Blocked image: only up to 16 relative local raster images are supported.";
          node.tagName = "span";
          node.children = [
            text(`[${node.properties.alt || "Image"} — ${message}]`),
          ];
          diagnostics.push({ ...position, severity: "warning", message });
        } else {
          const id = nextId();
          requests.push({ id, kind: "image", path });
          targets.set(id, { node, ...position });
        }
      }
      if (node.tagName === "code") {
        const classes = Array.isArray(node.properties.className)
          ? node.properties.className.map(String)
          : [];
        const language = classes
          .find((c) => c.startsWith("language-"))
          ?.slice(9);
        if (
          language &&
          !languages.registered(language) &&
          !["math", "mermaid"].includes(language)
        )
          node.properties.className = [...classes, "no-highlight"];
      }
    });
    return {
      input,
      tree,
      requests,
      targets,
      headings,
      diagnostics,
      decorations,
    };
  } catch (error) {
    return failedResult(input, error);
  }
}
function localError(node: Element, source: string, message: string) {
  node.tagName = "div";
  node.properties = { className: ["resource-error"] };
  node.children = [
    element("p", {}, [text(message)]),
    element("pre", {}, [text(source)]),
  ];
}
export async function finishRender(
  pending: PendingRender,
  resources: Record<string, ResourceValue> = {},
): Promise<RenderResult> {
  const { input, diagnostics } = pending;
  try {
    for (const request of pending.requests) {
      const target = pending.targets.get(request.id)!;
      const resource = resources[request.id];
      const valid =
        resource &&
        "url" in resource &&
        (request.kind === "mermaid"
          ? resource.url.startsWith("data:image/svg+xml;base64,")
          : /^data:image\/(png|jpeg|gif|webp);base64,/.test(resource.url));
      if (valid && resource && "url" in resource) {
        target.node.tagName = "img";
        target.node.properties = {
          src: resource.url,
          alt:
            request.kind === "mermaid"
              ? "Mermaid diagram"
              : (target.node.properties.alt ?? ""),
        };
        target.node.children = [];
      } else {
        const message =
          resource && "error" in resource
            ? resource.error
            : "Resource unavailable.";
        localError(
          target.node,
          target.source ?? String(target.node.properties.alt ?? "Image"),
          message,
        );
        diagnostics.push({
          from: target.from,
          to: target.to,
          severity: "warning",
          message,
        });
      }
    }
    const file = new VFile();
    const trusted = unified()
      .use(rehypeHighlight, {
        detect: false,
        plainText: ["text", "txt", "mermaid", "math"],
      })
      .use(rehypeKatex, {
        trust: false,
        strict: "warn",
        maxExpand: 1000,
        maxSize: 20,
        macros: {},
        output: "htmlAndMathml",
      })
      .use(rehypeStringify);
    const tree = await trusted.run(pending.tree, file);
    for (const message of file.messages)
      diagnostics.push({
        from:
          message.place && "start" in message.place
            ? (message.place.start.offset ?? 0)
            : 0,
        to:
          message.place && "end" in message.place
            ? (message.place.end.offset ?? 1)
            : 1,
        severity: "warning",
        message: message.reason,
      });
    const html = trusted.stringify(tree as Root);
    if (new TextEncoder().encode(html).length > 48 * 1024 * 1024)
      throw new Error("Serialized preview exceeds 48 MiB.");
    return {
      kind: "result",
      documentId: input.documentId,
      version: input.version,
      html,
      headings: pending.headings,
      diagnostics,
      decorations: pending.decorations,
    };
  } catch (error) {
    return failedResult(input, error);
  }
}
export async function renderDocument(
  input: RenderInput,
  resources: Record<string, ResourceValue> = {},
): Promise<RenderResult> {
  const prepared = await prepareRender(input);
  return "kind" in prepared ? prepared : finishRender(prepared, resources);
}
