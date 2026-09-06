export type Workspace = { id: string; name: string; root: string };
export type FileEntry = {
  path: string;
  name: string;
  kind: "directory" | "file";
};
export type FileSnapshot = { path: string; text: string; revision: string };
export type AppError = {
  code:
    | "NO_WORKSPACE"
    | "STALE_WORKSPACE"
    | "INVALID_PATH"
    | "NOT_FOUND"
    | "ALREADY_EXISTS"
    | "UNSUPPORTED_FILE"
    | "TOO_LARGE"
    | "INVALID_UTF8"
    | "CONFLICT"
    | "IO";
  message: string;
};
export type SearchMatch = {
  path: string;
  line: number;
  column: number;
  length: number;
  text: string;
};
export type SearchResult = {
  matches: SearchMatch[];
  truncated: boolean;
  skipped: number;
};
export type Session = {
  version: 1;
  tabs: string[];
  activePath: string | null;
  theme: "system" | "light" | "dark";
  wrap: boolean;
  previewMode: "split" | "source" | "preview";
  sidebarWidth: number;
  splitRatio: number;
  outlineVisible: boolean;
};
export const defaultSession: Session = {
  version: 1,
  tabs: [],
  activePath: null,
  theme: "system",
  wrap: true,
  previewMode: "split",
  sidebarWidth: 240,
  splitRatio: 0.5,
  outlineVisible: true,
};
export type RestoredSession = {
  workspace: Workspace | null;
  session: Session;
  notice: string | null;
};
