import { useEffect, useRef, useState } from "react";
import type { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  createDocumentState,
  editorTheme,
  themeCompartment,
  wrapCompartment,
} from "../editor/extensions";
import * as native from "../lib/native";
import { isDirty, type DocumentTab } from "./types";

const errorMessage = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : String(error);
const isConflict = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "CONFLICT";
const formatFor = (path: string): "md" | "mdx" =>
  /\.mdx$/i.test(path) ? "mdx" : "md";
type Flight = { promise: Promise<boolean>; pending: boolean };

export function useDocuments(
  workspaceId: string | null,
  theme: "light" | "dark",
  wrap: boolean,
) {
  const [tabs, setTabs] = useState<DocumentTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const documents = useRef<DocumentTab[]>([]);
  const workspace = useRef(workspaceId);
  const epoch = useRef(0);
  const alive = useRef(true);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const flights = useRef(new Map<string, Flight>());
  const settings = useRef({ theme, wrap });
  settings.current = { theme, wrap };
  if (workspace.current !== workspaceId) {
    workspace.current = workspaceId;
    epoch.current++;
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
  }
  const publish = (next: DocumentTab[]) => {
    documents.current = next;
    if (alive.current) setTabs(next);
  };
  const get = (id: string) => documents.current.find((tab) => tab.id === id);
  const patch = (id: string, values: Partial<DocumentTab>) =>
    publish(
      documents.current.map((tab) =>
        tab.id === id ? { ...tab, ...values } : tab,
      ),
    );
  const cancelTimer = (id: string) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
  };
  const fail = (id: string, error: unknown) =>
    patch(id, {
      status: isConflict(error) ? "Conflict" : "Error",
      error: errorMessage(error),
    });
  const valid = (generation: number, id: string) =>
    alive.current && epoch.current === generation && !!get(id);

  async function save(id: string, pathOverride?: string): Promise<boolean> {
    cancelTimer(id);
    const previous = flights.current.get(id);
    if (previous) {
      if (!pathOverride) {
        previous.pending = true;
        return previous.promise;
      }
      await previous.promise;
      return save(id, pathOverride);
    }
    const initial = get(id);
    if (!initial) return false;
    const root = workspace.current;
    if (!root) {
      fail(
        id,
        new Error(
          "Available in the desktop app: open a workspace before saving.",
        ),
      );
      return false;
    }
    const path = pathOverride ?? initial.path;
    if (!path) {
      fail(id, new Error("Choose a root-relative path to save this document."));
      return false;
    }
    if (!/\.(md|markdown|mdx)$/i.test(path)) {
      fail(id, new Error("Use a .md, .markdown, or .mdx extension."));
      return false;
    }
    if (!pathOverride && initial.status === "Conflict") return false;
    const generation = epoch.current;
    const flight: Flight = { promise: Promise.resolve(false), pending: false };
    // Defer execution so the flight is registered before even an immediate response.
    flight.promise = Promise.resolve()
      .then(async () => {
        let creating = pathOverride !== undefined || initial.path === null;
        let target = path;
        do {
          flight.pending = false;
          const tab = get(id);
          if (!tab || !valid(generation, id)) return false;
          if (!creating && !isDirty(tab)) return true;
          const editGeneration = tab.generation;
          const text = tab.state.doc.toString();
          patch(id, { status: "Saving", error: null });
          try {
            const snapshot = await native.writeDocument(
              root,
              target,
              text,
              creating ? null : tab.revision,
            );
            if (!valid(generation, id)) return false;
            const current = get(id)!;
            // A canonical identity may already be open; never silently replace its buffer.
            const duplicate = documents.current.find(
              (other) => other.id !== id && other.path === snapshot.path,
            );
            patch(id, {
              path: snapshot.path,
              title: snapshot.path.split("/").pop()!,
              format: formatFor(snapshot.path),
              revision: snapshot.revision,
              savedGeneration: editGeneration,
              status:
                current.generation === editGeneration ? "Saved" : "Unsaved",
              error: null,
            });
            if (duplicate && !isDirty(duplicate)) {
              cancelTimer(duplicate.id);
              publish(
                documents.current.filter((other) => other.id !== duplicate.id),
              );
            }
            target = snapshot.path;
            creating = false;
          } catch (error) {
            if (valid(generation, id)) fail(id, error);
            return false;
          }
        } while (flight.pending && valid(generation, id));
        return !isDirty(get(id)!);
      })
      .finally(() => {
        if (flights.current.get(id) === flight) flights.current.delete(id);
      });
    flights.current.set(id, flight);
    return flight.promise;
  }

  function newDocument(format: "md" | "mdx"): DocumentTab {
    const tab: DocumentTab = {
      id: crypto.randomUUID(),
      path: null,
      title: format === "mdx" ? "Untitled.mdx" : "Untitled.md",
      format,
      state: createDocumentState(
        "",
        settings.current.theme,
        settings.current.wrap,
      ),
      generation: 0,
      savedGeneration: 0,
      revision: null,
      status: "Unsaved",
      error: null,
      scrollTop: 0,
    };
    publish([...documents.current, tab]);
    setActiveId(tab.id);
    return tab;
  }
  async function openDocument(path: string): Promise<DocumentTab> {
    const existing = documents.current.find((tab) => tab.path === path);
    if (existing) {
      setActiveId(existing.id);
      return existing;
    }
    const root = workspace.current;
    if (!root) throw new Error("Open a workspace first.");
    const generation = epoch.current;
    const snapshot = await native.readDocument(root, path);
    if (!alive.current || epoch.current !== generation)
      throw new Error("Workspace changed.");
    const canonical = documents.current.find(
      (tab) => tab.path === snapshot.path,
    );
    if (canonical) {
      setActiveId(canonical.id);
      return canonical;
    }
    const tab: DocumentTab = {
      id: crypto.randomUUID(),
      path: snapshot.path,
      title: snapshot.path.split("/").pop()!,
      format: formatFor(snapshot.path),
      state: createDocumentState(
        snapshot.text,
        settings.current.theme,
        settings.current.wrap,
      ),
      generation: 0,
      savedGeneration: 0,
      revision: snapshot.revision,
      status: "Saved",
      error: null,
      scrollTop: 0,
    };
    publish([...documents.current, tab]);
    setActiveId(tab.id);
    return tab;
  }
  function updateState(
    id: string,
    state: EditorState,
    docChanged: boolean,
    scrollTop?: number,
  ) {
    const tab = get(id);
    if (!tab) return;
    patch(id, {
      state,
      scrollTop: scrollTop ?? tab.scrollTop,
      generation: tab.generation + (docChanged ? 1 : 0),
      ...(docChanged &&
      tab.status !== "Conflict" &&
      tab.status !== "Error" &&
      tab.status !== "Saving"
        ? { status: "Unsaved" as const }
        : {}),
    });
    if (!docChanged) return;
    cancelTimer(id);
    const flight = flights.current.get(id);
    if (flight) flight.pending = true;
    else if (tab.path && tab.status !== "Conflict" && tab.status !== "Error") {
      timers.current.set(
        id,
        setTimeout(() => {
          timers.current.delete(id);
          void save(id);
        }, 750),
      );
    }
  }
  async function reload(id: string): Promise<boolean> {
    cancelTimer(id);
    await flights.current.get(id)?.promise;
    const tab = get(id),
      root = workspace.current,
      generation = epoch.current;
    if (!tab?.path || !root) return false;
    try {
      const snapshot = await native.readDocument(root, tab.path);
      if (!valid(generation, id)) return false;
      if (get(id)!.generation !== tab.generation) {
        patch(id, {
          status: "Conflict",
          error: "The buffer changed while reading disk. Try Reload again.",
        });
        return false;
      }
      patch(id, {
        path: snapshot.path,
        state: createDocumentState(
          snapshot.text,
          settings.current.theme,
          settings.current.wrap,
        ),
        generation: tab.generation + 1,
        savedGeneration: tab.generation + 1,
        revision: snapshot.revision,
        status: "Saved",
        error: null,
        scrollTop: 0,
      });
      return true;
    } catch (error) {
      if (valid(generation, id)) fail(id, error);
      return false;
    }
  }
  async function refresh(): Promise<void> {
    await Promise.all([...flights.current.values()].map((f) => f.promise));
    const root = workspace.current,
      generation = epoch.current;
    if (!root) return;
    await Promise.all(
      documents.current
        .filter((tab) => tab.path)
        .map(async (tab) => {
          try {
            const snapshot = await native.readDocument(root, tab.path!);
            if (!valid(generation, tab.id)) return;
            const current = get(tab.id)!;
            if (current.revision === snapshot.revision) return;
            cancelTimer(tab.id);
            if (isDirty(current) || flights.current.has(tab.id)) {
              patch(tab.id, {
                status: "Conflict",
                error:
                  "This file changed on disk. Reload or explicitly overwrite to resolve it.",
              });
            } else {
              patch(tab.id, {
                state: createDocumentState(
                  snapshot.text,
                  settings.current.theme,
                  settings.current.wrap,
                ),
                revision: snapshot.revision,
                generation: current.generation + 1,
                savedGeneration: current.generation + 1,
                status: "Saved",
                error: null,
              });
            }
          } catch (error) {
            if (valid(generation, tab.id)) {
              cancelTimer(tab.id);
              fail(tab.id, error);
            }
          }
        }),
    );
  }
  async function overwrite(id: string): Promise<boolean> {
    cancelTimer(id);
    await flights.current.get(id)?.promise;
    const tab = get(id),
      root = workspace.current,
      generation = epoch.current;
    if (!tab?.path || !root) return false;
    try {
      const snapshot = await native.readDocument(root, tab.path);
      if (!valid(generation, id)) return false;
      patch(id, {
        revision: snapshot.revision,
        status: "Unsaved",
        error: null,
        savedGeneration: -1,
      });
      return save(id);
    } catch (error) {
      if (valid(generation, id)) fail(id, error);
      return false;
    }
  }
  function close(id: string) {
    cancelTimer(id);
    const index = documents.current.findIndex((tab) => tab.id === id);
    const next = documents.current.filter((tab) => tab.id !== id);
    publish(next);
    setActiveId((current) =>
      current === id
        ? (next[Math.min(index, next.length - 1)]?.id ?? null)
        : current,
    );
  }
  function clear() {
    epoch.current++;
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
    flights.current.clear();
    publish([]);
    setActiveId(null);
  }
  async function flush(): Promise<void> {
    await Promise.all(
      documents.current
        .filter(
          (tab) =>
            tab.path &&
            isDirty(tab) &&
            tab.status !== "Conflict" &&
            tab.status !== "Error",
        )
        .map((tab) => save(tab.id)),
    );
    await Promise.all([...flights.current.values()].map((f) => f.promise));
  }
  useEffect(() => {
    publish(
      documents.current.map((tab) => ({
        ...tab,
        state: tab.state.update({
          effects: [
            themeCompartment.reconfigure(editorTheme(theme)),
            wrapCompartment.reconfigure(wrap ? EditorView.lineWrapping : []),
          ],
        }).state,
      })),
    );
  }, [theme, wrap]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      epoch.current++;
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    };
  }, []);
  return {
    tabs,
    activeId,
    active: tabs.find((tab) => tab.id === activeId) ?? null,
    newDocument,
    openDocument,
    activate: setActiveId,
    updateState,
    save,
    close,
    clear,
    refresh,
    reload,
    overwrite,
    flush,
  };
}
