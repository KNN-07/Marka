import { useEffect, useRef, useState } from "react";
import type { SearchMatch, SearchResult } from "../lib/contracts";
import { searchWorkspace } from "../lib/native";
export default function SearchPanel({
  workspaceId,
  onSelect,
}: {
  workspaceId: string | null;
  onSelect: (match: SearchMatch) => void;
}) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const epoch = useRef(0);
  const running = useRef(false);
  const pending = useRef<{
    id: string;
    query: string;
    caseSensitive: boolean;
    version: number;
  } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current++;
      pending.current = null;
    };
  }, []);
  useEffect(() => {
    const version = ++epoch.current;
    pending.current = null;
    setError("");
    setResult(null);
    setLoading(false);
    if (!workspaceId || !query.trim()) return;
    const timer = setTimeout(() => {
      pending.current = { id: workspaceId, query, caseSensitive, version };
      setLoading(true);
      const drain = async () => {
        if (running.current) return;
        running.current = true;
        try {
          while (pending.current && mounted.current) {
            const task = pending.current;
            pending.current = null;
            try {
              const value = await searchWorkspace(
                task.id,
                task.query,
                task.caseSensitive,
              );
              if (mounted.current && task.version === epoch.current)
                setResult(value);
            } catch (reason) {
              if (mounted.current && task.version === epoch.current)
                setError((reason as Error).message ?? String(reason));
            } finally {
              if (mounted.current && task.version === epoch.current)
                setLoading(false);
            }
          }
        } finally {
          running.current = false;
        }
      };
      void drain();
    }, 250);
    return () => clearTimeout(timer);
  }, [workspaceId, query, caseSensitive]);
  return (
    <div className="search-panel">
      <label htmlFor="workspace-search">Search workspace</label>
      <input
        id="workspace-search"
        autoFocus
        type="search"
        placeholder="Find in saved files…"
        value={query}
        disabled={!workspaceId}
        onChange={(event) => setQuery(event.target.value)}
      />
      <label className="check-label">
        <input
          type="checkbox"
          checked={caseSensitive}
          onChange={(event) => setCaseSensitive(event.target.checked)}
        />
        Match case
      </label>
      <p className="muted small">
        Search covers saved files. Use document search for unsaved edits.
      </p>
      {!workspaceId && <p className="muted">Open a folder to search.</p>}
      {loading && <p role="status">Searching…</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <>
          <p className="small muted">
            {result.matches.length} matches
            {result.truncated ? " · Results limited" : ""}
            {result.skipped ? ` · ${result.skipped} files skipped` : ""}
          </p>
          <div className="search-results">
            {result.matches.map((match, index) => (
              <button
                key={`${match.path}:${match.line}:${match.column}:${index}`}
                onClick={() => onSelect(match)}
              >
                <strong>
                  {match.path}:{match.line}
                </strong>
                <span>{match.text}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
