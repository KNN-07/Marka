import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { EditorView } from "@codemirror/view";
import { openSearchPanel } from "@codemirror/search";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import {
  FilePlus2,
  FolderOpen,
  Save,
  Printer,
  Settings,
  Play,
  Square,
  PanelLeft,
  PanelRight,
  Search,
  Files,
  WrapText,
  ChevronDown,
} from "lucide-react";
import * as native from "./lib/native";
import {
  defaultSession,
  type Session,
  type Workspace,
  type SearchMatch,
  type RestoredSession,
} from "./lib/contracts";
import { useDocuments } from "./workspace/useDocuments";
import { isDirty, type DocumentTab } from "./workspace/types";
import SourceEditor from "./editor/SourceEditor";
import PreviewPane from "./preview/PreviewPane";
import WorkspaceSidebar from "./workspace/WorkspaceSidebar";
import SearchPanel from "./workspace/SearchPanel";
import TabBar from "./workspace/TabBar";
import OutlinePanel, { type Heading } from "./workspace/OutlinePanel";
import Modal from "./components/Modal";
import markaLogo from "../src-tauri/icons/marka.svg";
import MdxSettings from "./components/MdxSettings";
import { useMdxExecution } from "./workspace/useMdxExecution";
import { useExport } from "./export/useExport";
import type { ExportFormat } from "./export/document";

type PreviewResult = {
  headings: Heading[];
  diagnostics: {
    from: number;
    to: number;
    severity: "error" | "warning";
    message: string;
  }[];
  decorations: {
    from: number;
    to: number;
    kind: "jsx-tag" | "jsx-attribute" | "literal";
  }[];
};
type Dialog = {
  title: string;
  message: string;
  input?: string;
  label?: string;
  confirm: string;
  alternate?: string;
  externalUrl?: string;
  settings?: boolean;
  action?: (value: string) => Promise<boolean>;
  resolve: (value: "confirm" | "alternate" | "cancel") => void;
};
const snippets: Record<string, string> = {
  Heading: "## Heading",
  Bold: "**text**",
  Italic: "*text*",
  Strike: "~~text~~",
  "Inline code": "`code`",
  "Code block": "```js\nconst answer = 42;\n```",
  Link: "[label](path)",
  Quote: "> Quote",
  "Bullet list": "- Item",
  "Numbered list": "1. Item",
  Task: "- [ ] Task",
  Table: "| Column | Column |\n| --- | --- |\n| Value | Value |",
  Footnote: "A footnote[^note].\n\n[^note]: Footnote content.",
  "Inline math": "$E=mc^2$",
  "Display math": "$$\n\\frac{1}{2}\n$$",
  Mermaid: "```mermaid\nflowchart LR\n  Source --> Preview\n```",
  Callout:
    '<Callout type="tip" title="Note">\n\nHelpful information.\n\n</Callout>',
  Badge: '<Badge variant="success">Ready</Badge>',
  Tabs: '<Tabs defaultIndex={0}>\n  <Tab title="First">First panel</Tab>\n  <Tab title="Second">Second panel</Tab>\n</Tabs>',
};
const emptyPreview: PreviewResult = {
  headings: [],
  diagnostics: [],
  decorations: [],
};
export default function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [preferences, setPreferences] = useState<Session>(defaultSession);
  const [systemDark, setSystemDark] = useState(
    () => matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const theme =
    preferences.theme === "system"
      ? systemDark
        ? "dark"
        : "light"
      : preferences.theme;
  const documents = useDocuments(
    workspace?.id ?? null,
    theme,
    preferences.wrap,
  );
  const [sidebar, setSidebar] = useState<"files" | "search" | null>("files");
  const [notice, setNotice] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [ready, setReady] = useState(!native.nativeAvailable);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [dialogInput, setDialogInput] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [dialogBusy, setDialogBusy] = useState(false);
  const [preview, setPreview] = useState<PreviewResult>(emptyPreview);
  const [snapshot, setSnapshot] = useState<{
    id: string;
    version: number;
    source: string;
    format: "md" | "mdx";
    path: string | null;
  } | null>(null);
  const [navigation, setNavigation] = useState<{
    id: string;
    from: number;
    length: number;
  } | null>(null);
  const view = useRef<EditorView | null>(null);
  const current = useRef({ documents, workspace, preferences });
  current.current = { documents, workspace, preferences };
  const executable = Boolean(
    documents.active?.format === "mdx" &&
    documents.active.path &&
    preferences.allowMdxExecution &&
    preferences.mdxExecutionFiles.includes(documents.active.path),
  );
  const execution = useMdxExecution(
    workspace?.id ?? null,
    preferences,
    theme,
    () => current.current.documents.active ?? null,
    () => persist(),
  );
  const exporter = useExport(
    () => current.current.documents.active ?? null,
    workspace?.id ?? null,
    setNotice,
  );
  const operation = useRef(false);
  const openingLink = useRef(false);
  const generation = useRef(0);
  const restoration = useRef<Promise<RestoredSession> | null>(null);
  const restoreTabs = useRef<Session | null>(null);
  const suppressPersistence = useRef(false);
  const untouchedRecovery = useRef(false);
  const patchPreferences = (patch: Partial<Session>) => {
    untouchedRecovery.current = false;
    setPreferences((old) => ({ ...old, ...patch }));
  };
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const change = () => setSystemDark(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    const resizePreferences = () =>
      setPreferences((old) => {
        const sidebarWidth = Math.max(
          170,
          Math.min(old.sidebarWidth, 420, window.innerWidth * 0.4),
        );
        const splitRatio = Math.max(0.25, Math.min(0.75, old.splitRatio));
        return sidebarWidth === old.sidebarWidth &&
          splitRatio === old.splitRatio
          ? old
          : { ...old, sidebarWidth, splitRatio };
      });
    resizePreferences();
    window.addEventListener("resize", resizePreferences);
    return () => window.removeEventListener("resize", resizePreferences);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    if (!native.nativeAvailable) return;
    let live = true;
    restoration.current ??= native.restoreSession();
    restoration.current
      .then((restored) => {
        if (!live) return;
        setPreferences(restored.session);
        setNotice(restored.notice ?? "");
        untouchedRecovery.current = Boolean(
          restored.notice && !restored.workspace,
        );
        restoreTabs.current = restored.workspace ? restored.session : null;
        suppressPersistence.current = Boolean(restored.workspace);
        setWorkspace(restored.workspace);
        setReady(true);
      })
      .catch((error) => {
        if (live) {
          setNotice(error.message ?? String(error));
          setReady(true);
          untouchedRecovery.current = true;
        }
      });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    const session = restoreTabs.current;
    if (!workspace || !session) return;
    restoreTabs.current = null;
    const token = generation.current;
    void (async () => {
      let dropped = 0;
      let activeId: string | null = null;
      for (const path of session.tabs) {
        if (token !== generation.current) return;
        try {
          const opened = await current.current.documents.openDocument(path);
          if (path === session.activePath) activeId = opened.id;
        } catch {
          dropped++;
        }
      }
      if (token !== generation.current) return;
      if (activeId) current.current.documents.activate(activeId);
      if (dropped)
        setNotice(
          `${dropped} saved tab(s) could not be restored. Open the folder to locate them.`,
        );
      suppressPersistence.current = false;
    })();
  }, [workspace]);
  const persist = async () => {
    if (!native.nativeAvailable || untouchedRecovery.current) return;
    const now = current.current;
    await native.saveSession(
      {
        ...now.preferences,
        tabs: now.documents.tabs.flatMap((tab) => (tab.path ? [tab.path] : [])),
        activePath: now.documents.active?.path ?? null,
      },
      now.workspace?.id ?? null,
    );
  };
  useEffect(() => {
    if (
      !ready ||
      !native.nativeAvailable ||
      suppressPersistence.current ||
      untouchedRecovery.current
    )
      return;
    const timer = setTimeout(() => {
      void persist().catch((error) =>
        setNotice(error.message ?? String(error)),
      );
    }, 400);
    return () => clearTimeout(timer);
  }, [ready, preferences, workspace, documents.tabs, documents.activeId]);
  useEffect(() => {
    const tab = documents.active;
    if (!tab) {
      setSnapshot(null);
      return;
    }
    const timer = setTimeout(
      () =>
        setSnapshot({
          id: tab.id,
          version: tab.generation,
          source: tab.state.doc.toString(),
          format: tab.format,
          path: tab.path,
        }),
      250,
    );
    return () => clearTimeout(timer);
  }, [
    documents.active?.id,
    documents.active?.generation,
    documents.active?.path,
  ]);
  useEffect(() => setPreview(emptyPreview), [documents.active?.id]);
  const ask = (options: Omit<Dialog, "resolve">) =>
    new Promise<"confirm" | "alternate" | "cancel">((resolve) => {
      setDialogInput(options.input ?? "");
      setDialogError("");
      setDialogBusy(false);
      setDialog({ ...options, resolve });
    });
  const finishDialog = (value: "confirm" | "alternate" | "cancel") => {
    if (dialogBusy) return;
    const old = dialog;
    setDialog(null);
    old?.resolve(value);
  };
  const submitDialog = async () => {
    if (!dialog || dialogBusy) return;
    setDialogBusy(true);
    setDialogError("");
    try {
      if (dialog.action && !(await dialog.action(dialogInput))) return;
      setDialog(null);
      dialog.resolve("confirm");
    } catch (error) {
      setDialogError((error as Error).message ?? String(error));
    } finally {
      setDialogBusy(false);
    }
  };
  const openPreviewLink = (url: string) => {
    if (
      openingLink.current ||
      operation.current ||
      document.querySelector('[aria-modal="true"]')
    )
      return;
    const open = async () => {
      if (openingLink.current) return false;
      openingLink.current = true;
      try {
        if (!native.nativeAvailable)
          throw new Error(
            "Opening links in your default browser is available in the desktop app.",
          );
        await native.openExternalLink(url);
        return true;
      } finally {
        openingLink.current = false;
      }
    };
    if (current.current.preferences.warnExternalLinks) {
      void ask({
        title: "Open external link?",
        message:
          "This address will open in your default browser, outside Marka. Only continue if you trust the destination.",
        externalUrl: url,
        confirm: "Open in browser",
        action: open,
      });
    } else {
      void open().catch((error) => setNotice(error.message ?? String(error)));
    }
  };
  const saveDocument = async (id: string, saveAs = false): Promise<boolean> => {
    if (!native.nativeAvailable) {
      setNotice(
        "Folder and save actions are available in the desktop app. Your untitled editor and preview work here.",
      );
      return false;
    }
    const tab = current.current.documents.tabs.find((item) => item.id === id);
    if (!tab) return true;
    if (!current.current.workspace) {
      const chosen = await native.chooseWorkspace();
      if (!chosen) return false;
      untouchedRecovery.current = false;
      setWorkspace(chosen);
      setPreferences((old) => ({
        ...old,
        allowMdxExecution: false,
        mdxExecutionFiles: [],
        mdxPlugins: [],
      }));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    if (tab.path && !saveAs) return current.current.documents.save(id);
    const result = await ask({
      title: saveAs ? "Save document as" : "Save untitled document",
      message:
        "Choose a root-relative path in the workspace. The parent folder must already exist; existing files are never replaced by Save As.",
      label: "Document path",
      input: tab.path ?? `untitled.${tab.format}`,
      confirm: "Save",
      action: async (value) => {
        const path = value.trim();
        if (
          !path ||
          /^(?:[\\/]|[A-Za-z]:)/.test(path) ||
          path.includes("\\") ||
          path.includes(":") ||
          path
            .split("/")
            .some((part) => !part || part === "." || part === "..") ||
          !/\.(md|markdown|mdx)$/i.test(path)
        )
          throw new Error(
            "Enter a relative .md, .markdown, or .mdx path without traversal or backslashes.",
          );
        const ok = await current.current.documents.save(id, path);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (!ok)
          throw new Error(
            current.current.documents.tabs.find((item) => item.id === id)
              ?.error ??
              "The file could not be saved. Check the path and try again.",
          );
        setRefreshKey((value) => value + 1);
        return true;
      },
    });
    return result === "confirm";
  };
  const guard = async (ids?: string[]) => {
    await current.current.documents.flush();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const targets = ids ?? current.current.documents.tabs.map((tab) => tab.id);
    for (const id of targets) {
      const tab = current.current.documents.tabs.find((item) => item.id === id);
      if (!tab || !isDirty(tab)) continue;
      current.current.documents.activate(id);
      const choice = await ask({
        title: `Save changes to ${tab.title}?`,
        message:
          "This document has unsaved changes. Discarding cannot be undone.",
        confirm: "Save",
        alternate: "Discard",
      });
      if (choice === "cancel") return false;
      if (choice === "confirm" && !(await saveDocument(id))) return false;
    }
    return true;
  };
  const runGuarded = async (work: () => Promise<void>) => {
    if (operation.current || dialog) return;
    operation.current = true;
    try {
      await work();
    } catch (error) {
      setNotice((error as Error).message ?? String(error));
    } finally {
      operation.current = false;
    }
  };
  const openFolder = () => {
    if (!ready) return;
    if (!native.nativeAvailable) {
      setNotice("Open Folder is available in the desktop app.");
      return;
    }
    void runGuarded(async () => {
      if (!(await guard())) return;
      const chosen = await native.chooseWorkspace();
      if (!chosen) return;
      generation.current++;
      untouchedRecovery.current = false;
      current.current.documents.clear();
      setWorkspace(chosen);
      if (current.current.workspace?.root !== chosen.root)
        setPreferences((old) => ({
          ...old,
          allowMdxExecution: false,
          mdxExecutionFiles: [],
          mdxPlugins: [],
        }));
      setRefreshKey((value) => value + 1);
    });
  };
  const closeTab = (id: string) => {
    void runGuarded(async () => {
      if (await guard([id])) current.current.documents.close(id);
    });
  };
  const exit = async () => {
    if (!ready) return;
    await runGuarded(async () => {
      if (!(await guard())) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await persist();
      await native.completeExit();
    });
  };
  const refresh = async () => {
    try {
      await current.current.documents.refresh();
      setRefreshKey((value) => value + 1);
    } catch (error) {
      setNotice((error as Error).message ?? String(error));
    }
  };
  const printDocument = () => {
    if (executable) {
      setNotice(
        "Interactive MDX runs separately. Switch this file to safe mode for static export and printing.",
      );
      return;
    }
    void exporter.run("print");
  };
  const handlers = useRef({ exit, refresh, printDocument });
  handlers.current = { exit, refresh, printDocument };
  useEffect(() => {
    if (!native.nativeAvailable) return;
    let disposed = false;
    const releases: (() => void)[] = [];
    const install = (promise: Promise<() => void>) => {
      void promise
        .then((release) => {
          if (disposed) release();
          else releases.push(release);
        })
        .catch((error) => setNotice(error.message ?? String(error)));
    };
    const window = getCurrentWindow();
    install(
      window.onCloseRequested((event) => {
        event.preventDefault();
        void handlers.current.exit();
      }),
    );
    install(
      window.onFocusChanged((event) => {
        if (event.payload) void handlers.current.refresh();
      }),
    );
    install(
      listen("marka://exit-requested", () => {
        void handlers.current.exit();
      }),
    );
    install(
      listen("marka://print-requested", () => handlers.current.printDocument()),
    );
    return () => {
      disposed = true;
      releases.forEach((release) => release());
    };
  }, []);
  const navigate = (
    from: number,
    length = 0,
    id = current.current.documents.activeId,
  ) => {
    if (!id) return;
    setPreferences((old) => ({
      ...old,
      previewMode: old.previewMode === "preview" ? "split" : old.previewMode,
    }));
    setNavigation({ id, from, length });
  };
  useEffect(() => {
    const editor = view.current;
    if (!navigation || navigation.id !== documents.activeId || !editor) return;
    const start = Math.min(navigation.from, editor.state.doc.length);
    editor.dispatch({
      selection: {
        anchor: start,
        head: Math.min(start + navigation.length, editor.state.doc.length),
      },
      effects: EditorView.scrollIntoView(start, { y: "center" }),
    });
    editor.focus();
    setNavigation(null);
  }, [navigation, documents.activeId]);
  const openDocument = async (path: string) => {
    try {
      await current.current.documents.openDocument(path);
    } catch (error) {
      setNotice((error as Error).message ?? String(error));
    }
  };
  const selectMatch = async (match: SearchMatch) => {
    try {
      const tab = await current.current.documents.openDocument(match.path);
      if (isDirty(tab)) {
        setNotice(
          "This result is from the saved file. The open buffer has unsaved edits; use document search to locate the text.",
        );
        return;
      }
      const line = tab.state.doc.line(
        Math.min(match.line, tab.state.doc.lines),
      );
      navigate(line.from + match.column - 1, match.length, tab.id);
    } catch (error) {
      setNotice((error as Error).message ?? String(error));
    }
  };
  const insert = (name: string) => {
    const editor = view.current;
    if (!editor) return;
    const range = editor.state.selection.main;
    const selected = editor.state.sliceDoc(range.from, range.to);
    let text = snippets[name];
    if (selected) {
      const wrappers: Record<string, string> = {
        Bold: "**",
        Italic: "*",
        Strike: "~~",
        "Inline code": "`",
      };
      if (wrappers[name]) text = wrappers[name] + selected + wrappers[name];
      else if (name === "Heading") text = "## " + selected;
      else if (name === "Quote")
        text = selected
          .split("\n")
          .map((line) => "> " + line)
          .join("\n");
    }
    editor.dispatch({
      changes: { from: range.from, to: range.to, insert: text },
      selection: { anchor: range.from + text.length },
      userEvent: "input",
    });
    editor.focus();
  };
  const newFolder = (parent: string) => {
    void ask({
      title: "New folder",
      message: `Create one child folder in ${parent || "the workspace root"}.`,
      label: "Folder name",
      input: "",
      confirm: "Create folder",
      action: async (value) => {
        const name = value.trim();
        if (!name || name === "." || name === ".." || /[\\/:]/.test(name))
          throw new Error("Enter one folder name, without path separators.");
        const root = current.current.workspace;
        if (!root) throw new Error("Open a workspace first.");
        await native.createDirectory(
          root.id,
          parent ? `${parent}/${name}` : name,
        );
        setRefreshKey((value) => value + 1);
        return true;
      },
    });
  };
  const conflict = (tab: DocumentTab) => {
    void runGuarded(async () => {
      const choice = await ask({
        title: "File changed on disk",
        message:
          "Your buffer has been preserved. Reload discards your edits. Overwrite reads the latest revision before saving, and may conflict again if the file changes.",
        confirm: "Reload from Disk",
        alternate: "Overwrite…",
      });
      if (choice === "confirm") await current.current.documents.reload(tab.id);
      if (choice === "alternate") {
        const confirmed = await ask({
          title: "Overwrite disk version?",
          message:
            "Replace the external changes with the source currently in this tab?",
          confirm: "Overwrite",
        });
        if (confirmed === "confirm")
          await current.current.documents.overwrite(tab.id);
      }
    });
  };
  const keyboard = useRef({
    openFolder,
    closeTab,
    saveDocument,
    printDocument,
  });
  keyboard.current = { openFolder, closeTab, saveDocument, printDocument };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        document.querySelector('[aria-modal="true"]') ||
        !(event.ctrlKey || event.metaKey)
      )
        return;
      const key = event.key.toLowerCase();
      const now = current.current;
      let handled = true;
      if (key === "n") now.documents.newDocument(event.shiftKey ? "mdx" : "md");
      else if (key === "o") keyboard.current.openFolder();
      else if (key === "s" && now.documents.activeId)
        void keyboard.current
          .saveDocument(now.documents.activeId, event.shiftKey)
          .catch((error) => setNotice(error.message ?? String(error)));
      else if (key === "w" && now.documents.activeId)
        keyboard.current.closeTab(now.documents.activeId);
      else if (key === "p" && now.documents.activeId)
        keyboard.current.printDocument();
      else if (key === "f" && event.shiftKey) {
        setSidebar("search");
        requestAnimationFrame(() =>
          document.getElementById("workspace-search")?.focus(),
        );
      } else if (
        (key === "f" || (key === "h" && !event.metaKey)) &&
        now.documents.activeId
      ) {
        if (now.preferences.previewMode === "preview")
          setPreferences((old) => ({ ...old, previewMode: "split" }));
        const replace = key === "h" || (event.metaKey && event.altKey);
        requestAnimationFrame(() => {
          if (view.current) {
            openSearchPanel(view.current);
            if (replace)
              view.current.dom
                .querySelector<HTMLInputElement>('input[name="replace"]')
                ?.focus();
          }
        });
      } else handled = false;
      if (handled) event.preventDefault();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  const resize = (
    event: ReactPointerEvent<HTMLDivElement>,
    kind: "sidebar" | "split",
  ) => {
    event.preventDefault();
    const start = event.clientX;
    const initial =
      kind === "sidebar" ? preferences.sidebarWidth : preferences.splitRatio;
    const width =
      document.querySelector(".editor-panes")?.getBoundingClientRect().width ??
      800;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const move = (move: PointerEvent) => {
      if (kind === "sidebar")
        patchPreferences({
          sidebarWidth: Math.max(
            170,
            Math.min(
              Math.min(420, window.innerWidth * 0.4),
              initial + move.clientX - start,
            ),
          ),
        });
      else
        patchPreferences({
          splitRatio: Math.max(
            0.25,
            Math.min(0.75, initial + (move.clientX - start) / width),
          ),
        });
    };
    const end = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", end);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  };
  const onView = useCallback((editor: EditorView | null) => {
    view.current = editor;
  }, []);
  const onResult = useCallback(
    (result: PreviewResult) => {
      if (current.current.documents.activeId === snapshot?.id)
        setPreview(result);
    },
    [snapshot?.id],
  );
  const active = documents.active;
  const position = active
    ? active.state.doc.lineAt(active.state.selection.main.head)
    : null;
  const wordCount = useMemo(
    () =>
      snapshot?.id === active?.id
        ? (snapshot?.source.match(/\S+/g)?.length ?? 0)
        : 0,
    [snapshot, active?.id],
  );
  const nativeTitle = native.nativeAvailable
    ? undefined
    : "Available in the desktop app";
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <img className="brand-mark" src={markaLogo} alt="" />
          <strong>Marka</strong>
          <span className="brand-caption">a space for your words</span>
        </div>
        <div className="header-actions">
          <button
            aria-label="Open folder"
            onClick={openFolder}
            title={nativeTitle ?? "Open Folder (Ctrl/Cmd+O)"}
          >
            <FolderOpen size={16} />
            <span>Open folder</span>
          </button>
          <button aria-label="New" onClick={() => documents.newDocument("md")}>
            <FilePlus2 size={16} />
            <span>New</span>
          </button>
          <button onClick={() => documents.newDocument("mdx")}>New MDX</button>
          <button
            aria-label="Save"
            disabled={!active}
            onClick={() => {
              if (active)
                void saveDocument(active.id).catch((error) =>
                  setNotice(error.message ?? String(error)),
                );
            }}
            title={nativeTitle ?? "Save (Ctrl/Cmd+S)"}
          >
            <Save size={16} />
            <span>Save</span>
          </button>
          <button
            disabled={!active}
            title={nativeTitle}
            onClick={() => {
              if (active)
                void saveDocument(active.id, true).catch((error) =>
                  setNotice(error.message ?? String(error)),
                );
            }}
          >
            Save as
          </button>
          <select
            aria-label="Export document"
            title={
              executable
                ? "Switch this file to safe mode for static exports"
                : "Export current buffer without changing the source file"
            }
            value=""
            disabled={!active || exporter.busy || executable}
            onChange={(event) => {
              if (event.target.value)
                void exporter.run(event.target.value as ExportFormat);
            }}
          >
            <option value="">{exporter.busy ? "Preparing…" : "Export…"}</option>
            <option value="pdf">PDF (.pdf)</option>
            <option value="docx">Word (.docx)</option>
            <option value="html">HTML (.html)</option>
            <option value="txt">Plain text (.txt)</option>
          </select>
          <button
            aria-label="Print document"
            title={
              executable
                ? "Switch this file to safe mode for static printing"
                : (nativeTitle ?? "Print document (Ctrl/Cmd+P)")
            }
            disabled={
              !active || exporter.busy || !native.nativeAvailable || executable
            }
            onClick={printDocument}
          >
            <Printer size={16} />
            <span>Print</span>
          </button>
          <select
            aria-label="Color theme"
            value={preferences.theme}
            onChange={(event) =>
              patchPreferences({
                theme: event.target.value as Session["theme"],
              })
            }
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
          <button
            aria-label="Settings"
            title="Settings"
            disabled={!ready || !!dialog}
            onClick={() => {
              void ask({
                title: "Settings",
                message:
                  "Changes apply immediately. Preferences are saved automatically in the desktop app.",
                settings: true,
                confirm: "Done",
              });
            }}
          >
            <Settings size={16} />
          </button>
        </div>
      </header>
      {!native.nativeAvailable && (
        <div className="browser-banner">
          Browser preview · Real untitled editing · Folder and save actions are
          available in the desktop app.
        </div>
      )}
      {notice && (
        <div className="notice" role="status">
          <span>{notice}</span>
          <button onClick={openFolder}>Open folder</button>
          <button aria-label="Dismiss notice" onClick={() => setNotice("")}>
            ×
          </button>
        </div>
      )}
      <div
        className="workspace-layout"
        style={
          {
            "--sidebar-width": `${Math.min(preferences.sidebarWidth, window.innerWidth * 0.4)}px`,
          } as CSSProperties
        }
      >
        {sidebar && (
          <>
            <aside className="sidebar">
              <div className="sidebar-modes">
                <button
                  className={sidebar === "files" ? "selected" : ""}
                  onClick={() => setSidebar("files")}
                >
                  <Files size={15} />
                  Files
                </button>
                <button
                  className={sidebar === "search" ? "selected" : ""}
                  onClick={() => setSidebar("search")}
                >
                  <Search size={15} />
                  Search
                </button>
              </div>
              {sidebar === "files" ? (
                <WorkspaceSidebar
                  workspace={workspace}
                  refreshKey={refreshKey}
                  onOpen={(path) => {
                    void openDocument(path);
                  }}
                  onNewFolder={newFolder}
                  onRefresh={() => {
                    void refresh();
                  }}
                />
              ) : (
                <SearchPanel
                  workspaceId={workspace?.id ?? null}
                  onSelect={(match) => {
                    void selectMatch(match);
                  }}
                />
              )}
            </aside>
            <div
              className="resize-handle"
              role="separator"
              aria-label="Resize sidebar"
              aria-orientation="vertical"
              aria-valuemin={170}
              aria-valuemax={420}
              aria-valuenow={preferences.sidebarWidth}
              tabIndex={0}
              onPointerDown={(event) => resize(event, "sidebar")}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                  event.preventDefault();
                  patchPreferences({
                    sidebarWidth: Math.max(
                      170,
                      Math.min(
                        420,
                        preferences.sidebarWidth +
                          (event.key === "ArrowRight" ? 20 : -20),
                      ),
                    ),
                  });
                }
              }}
            />
          </>
        )}
        <main className="document-area">
          <TabBar
            tabs={documents.tabs}
            activeId={documents.activeId}
            onActivate={documents.activate}
            onClose={closeTab}
            onNew={() => documents.newDocument("md")}
          />
          <div className="document-controls">
            <button
              className="icon-button"
              onClick={() => setSidebar(sidebar ? null : "files")}
              title="Toggle sidebar"
              aria-label="Toggle sidebar"
            >
              <PanelLeft size={16} />
            </button>
            <div className="mode-switch" aria-label="Editor mode">
              {(["source", "split", "preview"] as const).map((mode) => (
                <button
                  key={mode}
                  aria-pressed={preferences.previewMode === mode}
                  className={preferences.previewMode === mode ? "selected" : ""}
                  onClick={() => patchPreferences({ previewMode: mode })}
                >
                  {mode[0].toUpperCase() + mode.slice(1)}
                </button>
              ))}
            </div>
            {active?.format === "mdx" && (
              <button
                disabled={
                  !executable || execution.busy || !native.nativeAvailable
                }
                title={
                  executable
                    ? "Run the current buffer in a separate restricted process"
                    : "Enable MDX execution and approve this file in Settings"
                }
                onClick={() => void execution.run()}
              >
                <Play size={14} /> {execution.busy ? "Compiling…" : "Run MDX"}
              </button>
            )}
            {(execution.busy || execution.status.running) && (
              <button
                onClick={() => void execution.stop()}
                title="Terminate the runtime or cancel compilation"
              >
                <Square size={14} /> Stop execution
              </button>
            )}
            <span className="controls-spacer" />
            <button
              className={`icon-button ${preferences.wrap ? "selected" : ""}`}
              aria-pressed={preferences.wrap}
              aria-label="Toggle line wrapping"
              title="Line wrapping"
              onClick={() => patchPreferences({ wrap: !preferences.wrap })}
            >
              <WrapText size={16} />
            </button>
            <button
              className="icon-button"
              title="Toggle outline"
              aria-label="Toggle outline"
              aria-pressed={preferences.outlineVisible}
              onClick={() =>
                patchPreferences({
                  outlineVisible: !preferences.outlineVisible,
                })
              }
            >
              <PanelRight size={16} />
            </button>
          </div>
          {active ? (
            <>
              <div className="format-toolbar" aria-label="Formatting toolbar">
                {[
                  "Heading",
                  "Bold",
                  "Italic",
                  "Strike",
                  "Inline code",
                  "Link",
                  "Quote",
                  "Bullet list",
                  "Task",
                ].map((name) => (
                  <button
                    key={name}
                    disabled={preferences.previewMode === "preview"}
                    title={name}
                    onClick={() => insert(name)}
                  >
                    {
                      (
                        {
                          Heading: "H₂",
                          Bold: "B",
                          Italic: "I",
                          Strike: "S̶",
                          "Inline code": "<>",
                          Link: "Link",
                          Quote: "❞",
                          "Bullet list": "List",
                          Task: "Task",
                        } as Record<string, string>
                      )[name]
                    }
                  </button>
                ))}
                <label className="insert-menu">
                  <span>Insert</span>
                  <ChevronDown size={12} />
                  <select
                    aria-label="Insert snippet"
                    value=""
                    disabled={preferences.previewMode === "preview"}
                    onChange={(event) => {
                      if (event.target.value) insert(event.target.value);
                    }}
                  >
                    <option value="">Insert…</option>
                    {Object.keys(snippets).map((name) => (
                      <option key={name}>{name}</option>
                    ))}
                  </select>
                </label>
              </div>
              {(active.status === "Conflict" || active.error) && (
                <div className="document-warning" role="alert">
                  <span>
                    {active.error ??
                      "This file changed on disk. Your edits are preserved."}
                  </span>
                  {active.status === "Conflict" && (
                    <button onClick={() => conflict(active)}>
                      Resolve conflict
                    </button>
                  )}
                  <button
                    onClick={() => {
                      void saveDocument(active.id, true);
                    }}
                  >
                    Save as
                  </button>
                </div>
              )}
              <div className="document-body">
                <div
                  className={`editor-panes mode-${preferences.previewMode}`}
                  style={
                    {
                      "--split": `${preferences.splitRatio * 100}%`,
                    } as CSSProperties
                  }
                >
                  <section
                    className="source-pane"
                    aria-label="Source editor"
                    hidden={preferences.previewMode === "preview"}
                  >
                    <div className="pane-label">
                      SOURCE<span>{active.format.toUpperCase()}</span>
                    </div>
                    <SourceEditor
                      tab={active}
                      theme={theme}
                      wrap={preferences.wrap}
                      onUpdate={documents.updateState}
                      onView={onView}
                      diagnostics={
                        executable
                          ? emptyPreview.diagnostics
                          : preview.diagnostics
                      }
                      decorations={
                        executable
                          ? emptyPreview.decorations
                          : preview.decorations
                      }
                    />
                  </section>
                  {preferences.previewMode === "split" && (
                    <div
                      className="resize-handle split-handle"
                      role="separator"
                      aria-label="Resize source and preview"
                      aria-orientation="vertical"
                      aria-valuemin={25}
                      aria-valuemax={75}
                      aria-valuenow={Math.round(preferences.splitRatio * 100)}
                      tabIndex={0}
                      onPointerDown={(event) => resize(event, "split")}
                      onKeyDown={(event) => {
                        if (
                          event.key === "ArrowLeft" ||
                          event.key === "ArrowRight"
                        ) {
                          event.preventDefault();
                          patchPreferences({
                            splitRatio: Math.max(
                              0.25,
                              Math.min(
                                0.75,
                                preferences.splitRatio +
                                  (event.key === "ArrowRight" ? 0.05 : -0.05),
                              ),
                            ),
                          });
                        }
                      }}
                    />
                  )}
                  <section
                    className="preview-pane"
                    aria-label="Live preview"
                    hidden={preferences.previewMode === "source"}
                  >
                    <div className="pane-label">
                      PREVIEW<span>{executable ? "Manual" : "Live"}</span>
                    </div>
                    <div
                      className="preview-mount"
                      style={{
                        visibility:
                          snapshot?.id === active.id ? "visible" : "hidden",
                      }}
                    >
                      {executable ? (
                        <div className="mdx-execution-panel">
                          <h2>Manual MDX execution</h2>
                          <p>
                            This file is approved to execute. Run MDX opens an
                            interactive snapshot in a separate restricted
                            process.
                          </p>
                          <p>
                            Editing never runs code automatically. Each Run
                            reads the current buffer and{" "}
                            {preferences.mdxPlugins.length} registered component
                            plugin(s).
                          </p>
                          <button
                            className="primary"
                            disabled={execution.busy}
                            onClick={() => void execution.run()}
                          >
                            <Play size={15} />{" "}
                            {execution.busy ? "Compiling…" : "Run MDX"}
                          </button>
                          {execution.status.running && (
                            <p role="status">
                              Runtime open for{" "}
                              <strong>{execution.status.path}</strong>. Use Stop
                              execution to terminate it, even if plugin code
                              hangs.
                            </p>
                          )}
                          {execution.error && (
                            <p className="error" role="alert">
                              {execution.error}
                            </p>
                          )}
                          <p>
                            Safe preview, static exports, and printing are
                            available when execution is disabled for this file.
                          </p>
                        </div>
                      ) : (
                        snapshot && (
                          <PreviewPane
                            documentId={snapshot.id}
                            version={snapshot.version}
                            format={snapshot.format}
                            source={snapshot.source}
                            theme={theme}
                            workspaceId={workspace?.id ?? null}
                            path={snapshot.path}
                            refreshKey={refreshKey}
                            onResult={onResult}
                            onOpenLink={openPreviewLink}
                          />
                        )
                      )}
                    </div>
                  </section>
                </div>
                {preferences.outlineVisible && !executable && (
                  <OutlinePanel
                    headings={preview.headings}
                    onSelect={(from) => navigate(from)}
                  />
                )}
              </div>
            </>
          ) : (
            <div className="welcome">
              <img className="welcome-mark" src={markaLogo} alt="" />
              <p className="eyebrow">YOUR WORDS, WITHOUT DISTRACTIONS</p>
              <h1>Make room for a good idea.</h1>
              <p>
                A local home for Markdown and MDX.
                <br />
                Write with clarity. See it come to life.
              </p>
              <div className="welcome-actions">
                <button
                  className="primary"
                  onClick={() => documents.newDocument("md")}
                >
                  <FilePlus2 size={17} />
                  New document
                </button>
                <button onClick={openFolder} title={nativeTitle}>
                  <FolderOpen size={17} />
                  Open a folder
                </button>
              </div>
              <div className="welcome-features">
                <span>Markdown + safe MDX</span>
                <span>Live diagrams & math</span>
                <span>Local-first, always</span>
              </div>
              {!ready && <p role="status">Restoring your workspace…</p>}
            </div>
          )}
        </main>
      </div>
      <footer className="statusbar">
        <span
          className={
            active?.status === "Conflict" || active?.status === "Error"
              ? "error"
              : ""
          }
        >
          <span className="status-dot" />
          {active?.status ?? "Ready"}
          {active?.path ? ` · ${active.path}` : ""}
        </span>
        <span className="status-right">
          {active && (
            <>
              <span>{active.format === "mdx" ? "MDX" : "Markdown"}</span>
              <span>{wordCount} words</span>
              <span>
                Ln {position?.number}, Col{" "}
                {position
                  ? active.state.selection.main.head - position.from + 1
                  : 1}
              </span>
            </>
          )}
          <span>UTF-8</span>
        </span>
      </footer>
      {dialog && (
        <Modal title={dialog.title} onCancel={() => finishDialog("cancel")}>
          <p>{dialog.message}</p>
          {dialog.externalUrl && (
            <code className="external-link-url" dir="ltr">
              {dialog.externalUrl}
            </code>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submitDialog();
            }}
          >
            {(dialog.settings || dialog.externalUrl) && (
              <label className="dialog-option">
                <input
                  type="checkbox"
                  checked={preferences.warnExternalLinks}
                  disabled={dialogBusy}
                  onChange={(event) =>
                    patchPreferences({
                      warnExternalLinks: event.target.checked,
                    })
                  }
                />
                Warn before opening external links
              </label>
            )}
            {dialog.settings && (
              <p>
                Ctrl+click a web link in the preview to open it in your default
                browser (Cmd+click on macOS). Turning off the warning does not
                enable ordinary-click navigation.
              </p>
            )}
            {dialog.settings && (
              <MdxSettings
                preferences={preferences}
                currentPath={active?.format === "mdx" ? active.path : null}
                available={native.nativeAvailable && !!workspace}
                onChange={patchPreferences}
              />
            )}
            {dialog.input !== undefined && (
              <label className="dialog-field">
                {dialog.label}
                <input
                  autoFocus
                  value={dialogInput}
                  disabled={dialogBusy}
                  onChange={(event) => setDialogInput(event.target.value)}
                />
              </label>
            )}
            {dialogError && (
              <p className="error" role="alert">
                {dialogError}
              </p>
            )}
            <div className="dialog-actions">
              {!dialog.settings && (
                <button
                  type="button"
                  disabled={dialogBusy}
                  onClick={() => finishDialog("cancel")}
                >
                  Cancel
                </button>
              )}
              {dialog.alternate && (
                <button
                  type="button"
                  disabled={dialogBusy}
                  onClick={() => finishDialog("alternate")}
                >
                  {dialog.alternate}
                </button>
              )}
              <button className="primary" type="submit" disabled={dialogBusy}>
                {dialogBusy ? "Working…" : dialog.confirm}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
