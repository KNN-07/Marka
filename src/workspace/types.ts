import type { EditorState } from "@codemirror/state";
export type DocumentTab = {
  id: string;
  path: string | null;
  title: string;
  format: "md" | "mdx";
  state: EditorState;
  generation: number;
  savedGeneration: number;
  revision: string | null;
  status: "Unsaved" | "Saving" | "Saved" | "Conflict" | "Error";
  error: string | null;
  scrollTop: number;
};
export const isDirty = (tab: DocumentTab) =>
  tab.path === null || tab.generation !== tab.savedGeneration;
