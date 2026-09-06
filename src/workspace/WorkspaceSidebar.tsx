import { useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FileText,
  FolderPlus,
  RefreshCw,
} from "lucide-react";
import type { FileEntry, Workspace } from "../lib/contracts";
import { listDirectory } from "../lib/native";
function Directory({
  workspaceId,
  path,
  depth,
  refreshKey,
  onOpen,
  onSelect,
}: {
  workspaceId: string;
  path: string;
  depth: number;
  refreshKey: number;
  onOpen: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError("");
    listDirectory(workspaceId, path)
      .then((value) => {
        if (live) setEntries(value);
      })
      .catch((reason) => {
        if (live) setError(reason.message ?? String(reason));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [workspaceId, path, refreshKey]);
  if (error)
    return (
      <p className="tree-message error" role="alert">
        {error}
      </p>
    );
  if (loading) return <p className="tree-message">Loading…</p>;
  if (!entries.length) return <p className="tree-message">Empty folder</p>;
  return (
    <ul className="file-tree">
      {entries.map((entry) => (
        <li key={entry.path}>
          <button
            className="tree-row"
            style={{ paddingLeft: 12 + depth * 14 }}
            title={entry.path}
            onClick={() => {
              if (entry.kind === "file") onOpen(entry.path);
              else {
                onSelect(entry.path);
                setExpanded((old) => {
                  const next = new Set(old);
                  if (next.has(entry.path)) next.delete(entry.path);
                  else next.add(entry.path);
                  return next;
                });
              }
            }}
            aria-expanded={
              entry.kind === "directory" ? expanded.has(entry.path) : undefined
            }
          >
            {entry.kind === "directory" ? (
              <>
                {expanded.has(entry.path) ? (
                  <ChevronDown size={12} />
                ) : (
                  <ChevronRight size={12} />
                )}
                <Folder size={15} />
              </>
            ) : (
              <>
                <span className="tree-spacer" />
                <FileText size={15} />
              </>
            )}
            <span>{entry.name}</span>
          </button>
          {entry.kind === "directory" && expanded.has(entry.path) && (
            <Directory
              workspaceId={workspaceId}
              path={entry.path}
              depth={depth + 1}
              refreshKey={refreshKey}
              onOpen={onOpen}
              onSelect={onSelect}
            />
          )}
        </li>
      ))}
    </ul>
  );
}
export default function WorkspaceSidebar({
  workspace,
  refreshKey,
  onOpen,
  onNewFolder,
  onRefresh,
}: {
  workspace: Workspace | null;
  refreshKey: number;
  onOpen: (path: string) => void;
  onNewFolder: (parent: string) => void;
  onRefresh: () => void;
}) {
  const [selected, setSelected] = useState("");
  useEffect(() => setSelected(""), [workspace?.id]);
  return (
    <>
      <div className="sidebar-heading">
        <button
          className="workspace-name"
          title={workspace?.root}
          onClick={() => setSelected("")}
        >
          {workspace?.name ?? "Workspace"}
        </button>
        <button
          className="icon-button"
          disabled={!workspace}
          onClick={() => onNewFolder(selected)}
          aria-label="New folder"
          title={`New folder in ${selected || "workspace root"}`}
        >
          <FolderPlus size={16} />
        </button>
        <button
          className="icon-button"
          disabled={!workspace}
          onClick={onRefresh}
          aria-label="Refresh workspace"
        >
          <RefreshCw size={15} />
        </button>
      </div>
      <div className="sidebar-scroll">
        {workspace ? (
          <Directory
            workspaceId={workspace.id}
            path=""
            depth={0}
            refreshKey={refreshKey}
            onOpen={onOpen}
            onSelect={setSelected}
          />
        ) : (
          <div className="sidebar-empty">
            <Folder size={28} />
            <p>No folder open</p>
            <small>
              Open a local folder to browse your Markdown and MDX files.
            </small>
          </div>
        )}
      </div>
      {workspace && (
        <div className="sidebar-caption">
          New folder location: {selected || "/"}
        </div>
      )}
    </>
  );
}
