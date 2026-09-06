import { parse } from "acorn";
import type { Element, ElementContent, Properties } from "hast";
import type { Program } from "estree";

export type Diagnostic = {
  from: number;
  to: number;
  severity: "error" | "warning";
  message: string;
};
export type Decoration = {
  from: number;
  to: number;
  kind: "jsx-tag" | "jsx-attribute" | "literal";
};
// MDX extends mdast with ESTree and JSX nodes; retain their parser positions.
export interface SyntaxNode {
  type: string;
  name?: string | null;
  value?: string;
  attributes?: {
    type: string;
    name?: string;
    value?: string | null | SyntaxNode;
    position?: SyntaxNode["position"];
  }[];
  children?: SyntaxNode[];
  data?: { estree?: Program; hProperties?: Properties };
  position?: { start: { offset?: number }; end: { offset?: number } };
  safeValue?: string | number | boolean | null;
  safeProps?: Record<string, string | number | boolean | null>;
  depth?: number;
  lang?: string | null;
  url?: string;
  alt?: string | null;
}
export const range = (node: Pick<SyntaxNode, "position">) => ({
  from: node.position?.start.offset ?? 0,
  to: node.position?.end.offset ?? (node.position?.start.offset ?? 0) + 1,
});
export const semanticTags = [
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "dd",
  "del",
  "details",
  "div",
  "dl",
  "dt",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "ins",
  "kbd",
  "li",
  "ol",
  "p",
  "pre",
  "q",
  "s",
  "section",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
];
export const htmlProps: Record<string, string[]> = {
  a: ["href"],
  img: ["src", "alt", "width", "height"],
  ol: ["start"],
  li: ["value"],
  td: ["colSpan", "rowSpan", "align"],
  th: ["colSpan", "rowSpan", "align"],
  details: ["open"],
  code: [],
};
export function literal(node: SyntaxNode): string | number | boolean | null {
  const ast =
    node.data?.estree ??
    parse(node.value ?? "", {
      ecmaVersion: 2024,
      sourceType: "script",
      locations: true,
    });
  if (!ast.body.length) return null;
  if (ast.body.length !== 1 || ast.body[0].type !== "ExpressionStatement")
    throw new Error(
      "Only literal values and empty JSX comments are supported.",
    );
  const expression = ast.body[0].expression;
  if (
    expression.type === "Literal" &&
    (expression.value === null ||
      typeof expression.value === "string" ||
      typeof expression.value === "boolean" ||
      (typeof expression.value === "number" &&
        Number.isFinite(expression.value)))
  )
    return expression.value;
  if (
    expression.type === "UnaryExpression" &&
    expression.operator === "-" &&
    expression.argument.type === "Literal" &&
    typeof expression.argument.value === "number" &&
    Number.isFinite(expression.argument.value)
  )
    return -expression.argument.value;
  throw new Error(
    "Safe MDX supports literal values only; JavaScript is not executed.",
  );
}
export function validateMdx(
  root: SyntaxNode,
  diagnostics: Diagnostic[],
  decorations: Decoration[],
) {
  function fail(node: Pick<SyntaxNode, "position">, message: string) {
    diagnostics.push({ ...range(node), severity: "error", message });
  }
  function walk(node: SyntaxNode, parent?: SyntaxNode) {
    if (node.type === "mdxjsEsm")
      fail(node, "Imports and exports are not supported in safe MDX.");
    if (/^mdx(?:Flow|Text)Expression$/.test(node.type)) {
      decorations.push({ ...range(node), kind: "literal" });
      try {
        node.safeValue = literal(node);
      } catch (error) {
        fail(node, (error as Error).message);
      }
    }
    if (/^mdxJsx(?:Flow|Text)Element$/.test(node.type)) {
      const name = node.name;
      const start = range(node).from;
      decorations.push({
        from: start,
        to: start + (name?.length ?? 0) + 2,
        kind: "jsx-tag",
      });
      if (
        name &&
        !semanticTags.includes(name) &&
        !["Callout", "Badge", "Tabs", "Tab"].includes(name)
      )
        fail(node, `Unsupported element <${name}>.`);
      const props: Record<string, string | number | boolean | null> = {};
      for (const attr of node.attributes ?? []) {
        decorations.push({ ...range(attr), kind: "jsx-attribute" });
        if (attr.type !== "mdxJsxAttribute" || !attr.name) {
          fail(attr, "Spread attributes are not supported.");
          continue;
        }
        if (Object.hasOwn(props, attr.name))
          fail(attr, `Duplicate prop ${attr.name}.`);
        try {
          props[attr.name] =
            attr.value == null
              ? true
              : typeof attr.value === "string"
                ? attr.value
                : literal(attr.value);
        } catch (error) {
          fail(attr, (error as Error).message);
        }
      }
      const allowed =
        name === "Callout"
          ? ["type", "title"]
          : name === "Badge"
            ? ["variant"]
            : name === "Tabs"
              ? ["defaultIndex"]
              : name === "Tab"
                ? ["title"]
                : name
                  ? ["title", "lang", "dir", ...(htmlProps[name] ?? [])]
                  : [];
      for (const prop of Object.keys(props))
        if (!allowed.includes(prop))
          fail(node, `Unsupported prop ${prop} on ${name ?? "fragment"}.`);
      if (
        name === "Callout" &&
        props.type !== undefined &&
        !["info", "tip", "warning", "danger"].includes(String(props.type))
      )
        fail(node, "Callout type must be info, tip, warning or danger.");
      if (
        (name === "Callout" || name === "Tab") &&
        props.title !== undefined &&
        typeof props.title !== "string"
      )
        fail(node, "title must be a string.");
      if (
        name === "Badge" &&
        props.variant !== undefined &&
        !["neutral", "info", "success", "warning"].includes(
          String(props.variant),
        )
      )
        fail(node, "Unsupported Badge variant.");
      if (
        name === "Tab" &&
        (parent?.name !== "Tabs" ||
          typeof props.title !== "string" ||
          !props.title.trim())
      )
        fail(
          node,
          "Tab requires a nonempty title and must be directly inside Tabs.",
        );
      if (name === "Tabs") {
        // MDX groups adjacent inline Tab elements into Markdown paragraphs.
        node.children = (node.children ?? []).flatMap((child) =>
          child.type === "paragraph" ? (child.children ?? []) : [child],
        );
        const children = (node.children ?? []).filter((child) => {
          if (child.type === "text" && !child.value?.trim()) return false;
          if (/^mdx(?:Flow|Text)Expression$/.test(child.type)) {
            try {
              const value = literal(child);
              return value !== null && typeof value !== "boolean";
            } catch {
              // The normal expression walk below reports the positioned error.
            }
          }
          return true;
        });
        const index = props.defaultIndex === undefined ? 0 : props.defaultIndex;
        if (!children.length || children.some((child) => child.name !== "Tab"))
          fail(node, "Tabs requires one or more direct Tab children.");
        if (
          typeof index !== "number" ||
          !Number.isInteger(index) ||
          index < 0 ||
          index >= children.length
        )
          fail(node, "defaultIndex must identify an existing Tab.");
      }
      node.safeProps = props;
    }
    for (const child of node.children ?? []) walk(child, node);
  }
  walk(root);
}
export const element = (
  tagName: string,
  properties: Properties = {},
  children: ElementContent[] = [],
): Element => ({ type: "element", tagName, properties, children });
export const text = (value: string): ElementContent => ({
  type: "text",
  value,
});
export function componentHandler(
  all: (node: SyntaxNode) => ElementContent[],
  nextId: () => string,
) {
  return (
    _state: unknown,
    node: SyntaxNode,
  ): ElementContent | ElementContent[] => {
    const props = node.safeProps ?? {};
    const children = all(node);
    if (!node.name) return children;
    if (node.name === "Callout")
      return element(
        "aside",
        { className: ["callout", `callout-${props.type ?? "info"}`] },
        [
          ...(props.title
            ? [element("strong", {}, [text(String(props.title))])]
            : []),
          ...children,
        ],
      );
    if (node.name === "Badge")
      return element(
        "span",
        { className: ["badge", `badge-${props.variant ?? "neutral"}`] },
        children,
      );
    if (node.name === "Tabs") {
      const group = nextId();
      return element("fieldset", { className: ["mdx-tabs"] }, [
        element("legend", { className: ["sr-only"] }, [
          text("Content options"),
        ]),
        ...(node.children ?? [])
          .filter((child) => child.name === "Tab")
          .map((child, index) => {
            const id = `${group}-${index}`;
            return element("div", { className: ["mdx-tab"] }, [
              element("input", {
                type: "radio",
                name: group,
                id,
                checked: index === (props.defaultIndex ?? 0),
              }),
              element("label", { htmlFor: [id] }, [
                text(String(child.safeProps?.title ?? "")),
              ]),
              element("section", { className: ["mdx-panel"] }, all(child)),
            ]);
          }),
      ]);
    }
    if (node.name === "Tab") return children;
    return element(node.name, props, children);
  };
}
