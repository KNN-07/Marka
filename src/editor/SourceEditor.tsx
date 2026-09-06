import { useEffect, useLayoutEffect, useRef } from "react";
import type { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { setDiagnostics, type Diagnostic } from "@codemirror/lint";
import type { DocumentTab } from "../workspace/types";
import { syntaxRanges, type SyntaxRange } from "./extensions";

export type SourceEditorProps = {
  tab: DocumentTab | null;
  theme: "light" | "dark";
  wrap: boolean;
  onUpdate: (
    id: string,
    state: EditorState,
    docChanged: boolean,
    scrollTop?: number,
  ) => void;
  onView: (view: EditorView | null) => void;
  diagnostics: Diagnostic[];
  decorations: SyntaxRange[];
};
export default function SourceEditor(props: SourceEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const currentId = useRef<string | null>(null);
  const releaseScroll = useRef<(() => void) | null>(null);
  const latest = useRef(props);
  latest.current = props;
  useLayoutEffect(() => {
    if (!host.current || !props.tab || view.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: props.tab.state,
      dispatchTransactions(transactions, instance) {
        instance.update(transactions);
        if (currentId.current)
          latest.current.onUpdate(
            currentId.current,
            instance.state,
            transactions.some((tr) => tr.docChanged),
            instance.scrollDOM.scrollTop,
          );
      },
    });
    view.current = editor;
    currentId.current = props.tab.id;
    editor.scrollDOM.scrollTop = props.tab.scrollTop;
    editor.contentDOM.setAttribute("aria-label", "Document source");
    const scroll = () => {
      if (currentId.current)
        latest.current.onUpdate(
          currentId.current,
          editor.state,
          false,
          editor.scrollDOM.scrollTop,
        );
    };
    editor.scrollDOM.addEventListener("scroll", scroll);
    releaseScroll.current = () =>
      editor.scrollDOM.removeEventListener("scroll", scroll);
    latest.current.onView(editor);
    // Kept until unmount, even when the last tab closes.
  });
  useLayoutEffect(() => {
    const editor = view.current;
    if (!editor) return;
    if (!props.tab) {
      currentId.current = null;
      latest.current.onView(null);
      return;
    }
    const switched = currentId.current !== props.tab.id;
    currentId.current = props.tab.id;
    if (editor.state !== props.tab.state) editor.setState(props.tab.state);
    if (switched) {
      editor.scrollDOM.scrollTop = props.tab.scrollTop;
      latest.current.onView(editor);
    }
  }, [props.tab]);
  useEffect(() => {
    const editor = view.current;
    if (!editor || !props.tab) return;
    const diagnostics = props.diagnostics.filter(
      (d) => d.from >= 0 && d.to >= d.from && d.to <= editor.state.doc.length,
    );
    editor.dispatch(setDiagnostics(editor.state, diagnostics), {
      effects: syntaxRanges.of(props.decorations),
    });
  }, [props.tab?.id, props.diagnostics, props.decorations]);
  useEffect(
    () => () => {
      latest.current.onView(null);
      releaseScroll.current?.();
      releaseScroll.current = null;
      view.current?.destroy();
      view.current = null;
      currentId.current = null;
    },
    [],
  );
  return (
    <div
      ref={host}
      className="source-editor"
      style={{
        height: "100%",
        minHeight: 0,
        display: props.tab ? undefined : "none",
      }}
    />
  );
}
