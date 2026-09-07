import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  Workspace,
  FileEntry,
  FileSnapshot,
  SearchResult,
  Session,
  RestoredSession,
} from "./contracts";
export const nativeAvailable = isTauri();
export const chooseWorkspace = () =>
  invoke<Workspace | null>("choose_workspace");
export const restoreSession = () => invoke<RestoredSession>("restore_session");
export const listDirectory = (workspaceId: string, path: string) =>
  invoke<FileEntry[]>("list_directory", { workspaceId, path });
export const readDocument = (workspaceId: string, path: string) =>
  invoke<FileSnapshot>("read_document", { workspaceId, path });
export const writeDocument = (
  workspaceId: string,
  path: string,
  text: string,
  expectedRevision: string | null,
) =>
  invoke<FileSnapshot>("write_document", {
    workspaceId,
    path,
    text,
    expectedRevision,
  });
export const createDirectory = (workspaceId: string, path: string) =>
  invoke<void>("create_directory", { workspaceId, path });
export const searchWorkspace = (
  workspaceId: string,
  query: string,
  caseSensitive: boolean,
) =>
  invoke<SearchResult>("search_workspace", {
    workspaceId,
    query,
    caseSensitive,
  });
export const readAsset = (workspaceId: string, path: string) =>
  invoke<ArrayBuffer>("read_asset", { workspaceId, path });
export const saveSession = (session: Session, workspaceId: string | null) =>
  invoke<void>("save_session", { session, workspaceId });
export const completeExit = () => invoke<void>("complete_exit");
export const openExternalLink = (url: string) =>
  invoke<void>("open_external_link", { url });

export async function saveExport(
  format: string,
  name: string,
  bytes: Uint8Array,
): Promise<boolean> {
  if (bytes.byteLength > 64 * 1024 * 1024)
    throw new Error("Exports are limited to 64 MiB.");
  const encodedName = encodeURIComponent(
    Array.from(name).slice(0, 120).join(""),
  );
  return invoke<boolean>("save_export", bytes, {
    headers: { "x-marka-format": format, "x-marka-name": encodedName },
  });
}

export async function openPrintDocument(
  title: string,
  html: string,
): Promise<void> {
  return invoke<void>("open_print_document", { title, html });
}
