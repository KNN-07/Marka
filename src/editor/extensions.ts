import {
  Compartment,
  EditorState,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  type DecorationSet,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  bracketMatching,
  defaultHighlightStyle,
  HighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  markdown,
  markdownLanguage,
  markdownKeymap,
} from "@codemirror/lang-markdown";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completeFromList,
  completionKeymap,
  snippetCompletion,
} from "@codemirror/autocomplete";
import { search, searchKeymap } from "@codemirror/search";
import { lintGutter } from "@codemirror/lint";
import { tags } from "@lezer/highlight";

export type SyntaxRange = {
  from: number;
  to: number;
  kind: "jsx-tag" | "jsx-attribute" | "literal";
};
export const themeCompartment = new Compartment();
export const wrapCompartment = new Compartment();
export const syntaxRanges = StateEffect.define<SyntaxRange[]>();
const ranges = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const effect of tr.effects)
      if (effect.is(syntaxRanges)) {
        value = Decoration.set(
          effect.value
            .filter(
              (r) => r.from >= 0 && r.to > r.from && r.to <= tr.newDoc.length,
            )
            .map((r) =>
              Decoration.mark({ class: `cm-mdx-${r.kind}` }).range(
                r.from,
                r.to,
              ),
            ),
          true,
        );
      }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});
const darkHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "#d9a8f3" },
  { tag: [tags.string, tags.inserted], color: "#a6d9ae" },
  { tag: [tags.number, tags.bool, tags.null], color: "#e8bd8b" },
  { tag: [tags.comment, tags.meta], color: "#a2b1b9" },
  { tag: [tags.link, tags.url, tags.tagName], color: "#82d8cd" },
  { tag: tags.heading, color: "#a6d8ef", fontWeight: "bold" },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
]);
export const editorTheme = (theme: "light" | "dark") => [
  EditorView.theme(
    {
      "&": {
        height: "100%",
        backgroundColor: "var(--surface, transparent)",
        color: "var(--text, inherit)",
      },
      ".cm-scroller": {
        overflow: "auto",
        fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
        fontSize: "14px",
        lineHeight: "1.7",
      },
      ".cm-content": { padding: "20px 0" },
      ".cm-line": { padding: "0 20px" },
      ".cm-gutters": {
        backgroundColor: "transparent",
        color: theme === "dark" ? "#88959c" : "#77838b",
        border: "none",
      },
      ".cm-activeLine, .cm-activeLineGutter": {
        backgroundColor: theme === "dark" ? "#ffffff08" : "#00000004",
      },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection":
        { backgroundColor: theme === "dark" ? "#245653" : "#c8e6e1" },
      ".cm-cursor": {
        borderLeftColor: theme === "dark" ? "#e3eceb" : "#182e2d",
      },
      ".cm-mdx-jsx-tag": { color: theme === "dark" ? "#79d8c6" : "#087567" },
      ".cm-mdx-jsx-attribute": {
        color: theme === "dark" ? "#cfb4ed" : "#8253a2",
      },
      ".cm-mdx-literal": { color: theme === "dark" ? "#edc487" : "#996322" },
    },
    { dark: theme === "dark" },
  ),
  syntaxHighlighting(
    theme === "dark" ? darkHighlightStyle : defaultHighlightStyle,
  ),
];
const completions = completeFromList([
  snippetCompletion(
    '<Callout type="${info}" title="${Note}">\n${Content}\n</Callout>',
    { label: "Callout", type: "text", detail: "Safe MDX callout" },
  ),
  snippetCompletion('<Badge variant="${neutral}">${Label}</Badge>', {
    label: "Badge",
    type: "text",
  }),
  snippetCompletion(
    '<Tabs defaultIndex={0}>\n  <Tab title="${First}">${Content}</Tab>\n  <Tab title="${Second}">${Content}</Tab>\n</Tabs>',
    { label: "Tabs", type: "text" },
  ),
  snippetCompletion("[${label}](${url})", { label: "link", type: "text" }),
  snippetCompletion("- [ ] ${task}", { label: "task", type: "text" }),
  snippetCompletion(
    "| ${Column} | ${Column} |\n| --- | --- |\n| ${Value} | ${Value} |",
    { label: "table", type: "text" },
  ),
  snippetCompletion(
    "```mermaid\nflowchart LR\n  ${Source} --> ${Preview}\n```",
    { label: "mermaid", type: "text" },
  ),
  snippetCompletion("$${E=mc^2}$", { label: "inline math", type: "text" }),
  snippetCompletion("$$\n\\frac{${1}}{${2}}\n$$", {
    label: "display math",
    type: "text",
  }),
  snippetCompletion("[^${note}]\n\n[^${note}]: ${Footnote content}", {
    label: "footnote",
    type: "text",
  }),
]);
export function createDocumentState(
  text: string,
  theme: "light" | "dark",
  wrap: boolean,
): EditorState {
  return EditorState.create({
    doc: text,
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      drawSelection(),
      history(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      foldGutter(),
      closeBrackets(),
      markdown({
        base: markdownLanguage,
        htmlTagLanguage: html(),
        codeLanguages: (info) => {
          switch (info.toLowerCase()) {
            case "js":
            case "javascript":
              return javascript().language;
            case "jsx":
              return javascript({ jsx: true }).language;
            case "ts":
            case "typescript":
              return javascript({ typescript: true }).language;
            case "tsx":
              return javascript({ typescript: true, jsx: true }).language;
            case "json":
              return json().language;
            case "html":
              return html().language;
            case "css":
              return css().language;
            default:
              return null;
          }
        },
      }),
      autocompletion({ override: [completions] }),
      search(),
      lintGutter(),
      ranges,
      keymap.of([
        ...markdownKeymap,
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        ...foldKeymap,
        ...completionKeymap,
        indentWithTab,
      ]),
      themeCompartment.of(editorTheme(theme)),
      wrapCompartment.of(wrap ? EditorView.lineWrapping : []),
    ],
  });
}
