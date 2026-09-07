import * as React from "react";
import * as ReactDOM from "react-dom/client";
import * as jsxRuntime from "react/jsx-runtime";
import * as jsxDevRuntime from "react/jsx-dev-runtime";
import * as mdxReact from "@mdx-js/react";
import { renderMermaid } from "../preview/mermaid";
import previewCss from "../preview/preview.css?raw";
import katexCss from "../generated/katex.css?raw";
import lightHighlight from "highlight.js/styles/github.css?raw";
import darkHighlight from "highlight.js/styles/github-dark.css?raw";
const scriptNonce = (document.currentScript as HTMLScriptElement).nonce;

type Module = { exports: Record<string, unknown> };
type Factory = (
  module: Module,
  exports: Module["exports"],
  require: (specifier: string) => unknown,
) => void;
type Plugin = { name: string; path: string; exportName: string };
const notify = (kind: "boot" | "ready" | "error", message?: string) =>
  parent.postMessage({ markaMdx: true, kind, message }, "*");
const report = (error: unknown) =>
  notify("error", error instanceof Error ? error.message : String(error));
window.addEventListener("error", (event) =>
  report(event.error || event.message),
);
window.addEventListener("unhandledrejection", (event) => report(event.reason));
// No host requests, navigation, downloads or form actions are bridged out of this opaque frame.
document.addEventListener(
  "click",
  (event) => {
    if (event.target instanceof Element && event.target.closest("a"))
      event.preventDefault();
  },
  true,
);
document.addEventListener("submit", (event) => event.preventDefault(), true);

function Callout({
  children,
  type = "info",
  title,
}: {
  children?: React.ReactNode;
  type?: string;
  title?: string;
}) {
  return (
    <aside className={`callout callout-${type}`}>
      {title && <strong>{title}</strong>}
      {children}
    </aside>
  );
}
function Badge({
  children,
  variant = "neutral",
}: {
  children?: React.ReactNode;
  variant?: string;
}) {
  return <span className={`badge badge-${variant}`}>{children}</span>;
}
function Tab({ children }: { children?: React.ReactNode; title: string }) {
  return <>{children}</>;
}
function Tabs({
  children,
  defaultIndex = 0,
}: {
  children?: React.ReactNode;
  defaultIndex?: number;
}) {
  const group = React.useId();
  const tabs = React.Children.toArray(children).filter(
    React.isValidElement,
  ) as React.ReactElement<{ title: string; children?: React.ReactNode }>[];
  if (
    !tabs.length ||
    tabs.some(
      (tab) =>
        tab.type !== Tab ||
        typeof tab.props.title !== "string" ||
        !tab.props.title.trim(),
    )
  )
    throw new Error("Tabs requires direct Tab children with nonempty titles.");
  if (
    !Number.isInteger(defaultIndex) ||
    defaultIndex < 0 ||
    defaultIndex >= tabs.length
  )
    throw new Error("Tabs defaultIndex must identify an existing Tab.");
  return (
    <fieldset className="mdx-tabs">
      <legend className="sr-only">Content options</legend>
      {tabs.map((tab, index) => {
        const id = `${group}-${index}`;
        return (
          <div className="mdx-tab" key={id}>
            <input
              type="radio"
              name={group}
              id={id}
              defaultChecked={index === defaultIndex}
            />
            <label htmlFor={id}>{tab.props.title}</label>
            <section className="mdx-panel">{tab.props.children}</section>
          </div>
        );
      })}
    </fieldset>
  );
}
const Theme = React.createContext<"light" | "dark">("light");
function Code({ className, children, ...props }: React.ComponentProps<"code">) {
  const theme = React.useContext(Theme);
  const source = String(children ?? "");
  const mermaid = className?.split(/\s+/).includes("language-mermaid");
  const [diagram, setDiagram] = React.useState<{
    url?: string;
    error?: string;
  }>({});
  React.useEffect(() => {
    if (!mermaid) return;
    let current = true;
    setDiagram({});
    void renderMermaid(source, theme, () => current).then(
      (url) => {
        if (current) setDiagram({ url });
      },
      (error) => {
        if (current) setDiagram({ error: String(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [mermaid, source, theme]);
  if (mermaid)
    return diagram.error ? (
      <code role="alert">{diagram.error}</code>
    ) : diagram.url ? (
      <img src={diagram.url} alt="Mermaid diagram" />
    ) : (
      <code>Rendering diagram…</code>
    );
  return (
    <code {...props} className={className}>
      {children}
    </code>
  );
}
class Boundary extends React.Component<
  { children: React.ReactNode },
  { error: string | null }
> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  componentDidCatch(error: Error) {
    report(error);
  }
  render() {
    return this.state.error ? (
      <pre role="alert">{this.state.error}</pre>
    ) : (
      this.props.children
    );
  }
}
const builtins: Record<string, unknown> = {
  react: React,
  "react/jsx-runtime": jsxRuntime,
  "react/jsx-dev-runtime": jsxDevRuntime,
  "react-dom/client": ReactDOM,
  "@mdx-js/react": mdxReact,
};
const start = (
  factories: Record<string, Factory>,
  dependencies: Record<string, Record<string, string>>,
  entry: string,
  plugins: Plugin[],
  theme: "light" | "dark",
) => {
  delete (window as unknown as { __MARKA_MDX_START__?: unknown })
    .__MARKA_MDX_START__;
  try {
    document.documentElement.dataset.theme = theme;
    const style = document.createElement("style");
    style.textContent = `${previewCss}\n${katexCss}\n${theme === "dark" ? darkHighlight : lightHighlight}\nbutton{cursor:pointer;padding:.4em .8em}`;
    document.head.append(style);
    const cache = new Map<string, Module>();
    const load = (path: string): unknown => {
      if (Object.hasOwn(builtins, path)) return builtins[path];
      const cached = cache.get(path);
      if (cached) return cached.exports;
      if (!Object.hasOwn(factories, path))
        throw new Error(`Unknown module ${path}`);
      const module: Module = { exports: {} };
      cache.set(path, module);
      factories[path](module, module.exports, (specifier) => {
        const imports = dependencies[path];
        if (!Object.hasOwn(imports, specifier))
          throw new Error(`${path}: unregistered import ${specifier}`);
        return load(imports[specifier]);
      });
      return module.exports;
    };
    const components: Record<string, React.ElementType> = {
      Callout,
      Badge,
      Tabs,
      Tab,
      code: Code,
    };
    for (const plugin of plugins) {
      const module = load(plugin.path) as Record<string, unknown>;
      if (!Object.hasOwn(module, plugin.exportName))
        throw new Error(`${plugin.path}: missing export ${plugin.exportName}`);
      components[plugin.name] = module[plugin.exportName] as React.ElementType;
    }
    const Content = (
      load(entry) as {
        default: React.ComponentType<{ components: typeof components }>;
      }
    ).default;
    const mount = document.createElement("main");
    document.body.append(mount);
    ReactDOM.createRoot(mount, {
      onUncaughtError: report,
      onCaughtError: report,
      onRecoverableError: report,
    }).render(
      <Boundary>
        <Theme.Provider value={theme}>
          <mdxReact.MDXProvider components={components}>
            <Content components={components} />
          </mdxReact.MDXProvider>
        </Theme.Provider>
      </Boundary>,
    );
    notify("ready");
  } catch (error) {
    report(error);
  }
};
(
  window as unknown as { __MARKA_MDX_START__: typeof start }
).__MARKA_MDX_START__ = start;
// Create the program blob in this opaque origin, not in its parent storage partition.
const acceptProgram = (event: MessageEvent) => {
  if (
    !event.isTrusted ||
    event.source !== parent ||
    event.data?.kind !== "marka-mdx-program" ||
    typeof event.data.code !== "string"
  )
    return;
  window.removeEventListener("message", acceptProgram);
  if (new TextEncoder().encode(event.data.code).length > 32 * 1024 * 1024) {
    report(new Error("MDX program exceeds 32 MiB."));
    return;
  }
  const url = URL.createObjectURL(
    new Blob([event.data.code], { type: "text/javascript" }),
  );
  const script = document.createElement("script");
  script.nonce = scriptNonce;
  script.src = url;
  script.onload = () => {
    URL.revokeObjectURL(url);
    script.remove();
  };
  script.onerror = () => {
    URL.revokeObjectURL(url);
    report(new Error("The isolated MDX program could not load."));
  };
  document.body.append(script);
};
window.addEventListener("message", acceptProgram);
notify("boot");
