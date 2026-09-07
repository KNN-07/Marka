import type { MdxPlugin, MdxModule, MdxRunPayload } from "../lib/contracts";
export type CompileInput = {
  workspaceId: string;
  path: string;
  source: string;
  plugins: MdxPlugin[];
  theme: "light" | "dark";
};
export type Resource =
  | { kind: "module"; importer: string | null; specifier: string }
  | { kind: "image"; path: string };
export type ToWorker =
  | { kind: "compile"; input: CompileInput }
  | {
      kind: "resource";
      id: number;
      value?: MdxModule | string;
      error?: string;
    };
export type FromWorker =
  | { kind: "resource"; id: number; resource: Resource }
  | { kind: "done"; payload: MdxRunPayload }
  | { kind: "error"; error: string };
export const SOURCE_LIMIT = 5 * 1024 * 1024;
export const GRAPH_LIMIT = 20 * 1024 * 1024;
export const PAYLOAD_LIMIT = 32 * 1024 * 1024;
export const MODULE_LIMIT = 128;
export const PLUGIN_LIMIT = 32;
export const ACTIVE_TIMEOUT = 30_000;
export const BUILTINS: Record<string, true> = {
  react: true,
  "react/jsx-runtime": true,
  "react/jsx-dev-runtime": true,
  "react-dom/client": true,
  "@mdx-js/react": true,
};
