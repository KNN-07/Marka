import { useState } from "react";
import type { MdxPlugin, Session } from "../lib/contracts";

type Props = {
  preferences: Session;
  currentPath: string | null;
  available: boolean;
  onChange: (patch: Partial<Session>) => void;
};
export default function MdxSettings({
  preferences,
  currentPath,
  available,
  onChange,
}: Props) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [exportName, setExportName] = useState("default");
  const [error, setError] = useState("");
  const register = () => {
    const plugin: MdxPlugin = {
      name: name.trim(),
      path: path.trim(),
      exportName: exportName.trim(),
    };
    if (
      !/^[A-Z][A-Za-z0-9]{0,63}$/.test(plugin.name) ||
      ["Callout", "Badge", "Tabs", "Tab"].includes(plugin.name)
    ) {
      setError(
        "Choose a component name beginning with an uppercase letter (up to 64 letters or digits). Built-in names are reserved.",
      );
      return;
    }
    if (!/^[$A-Z_a-z][$\w]{0,63}$/.test(plugin.exportName)) {
      setError("Choose a JavaScript export name, or default.");
      return;
    }
    if (
      !/\.(jsx|tsx|mdx)$/i.test(plugin.path) ||
      /[\\:\u0000-\u001f\u007f]/.test(plugin.path) ||
      plugin.path
        .split("/")
        .some((part) => !part || part === "." || part === "..")
    ) {
      setError(
        "Choose a clean workspace-relative .jsx, .tsx, or .mdx path, such as components/Counter.tsx.",
      );
      return;
    }
    if (preferences.mdxPlugins.some((item) => item.name === plugin.name)) {
      setError(
        "That component name is already registered. Remove its registration before replacing it.",
      );
      return;
    }
    if (preferences.mdxPlugins.length >= 32) {
      setError("A workspace can register up to 32 components.");
      return;
    }
    onChange({ mdxPlugins: [...preferences.mdxPlugins, plugin] });
    setName("");
    setPath("");
    setExportName("default");
    setError("");
  };
  return (
    <>
      <fieldset className="mdx-settings">
        <legend>Executable MDX</legend>
        <label className="dialog-option">
          <input
            type="checkbox"
            disabled={!available}
            checked={preferences.allowMdxExecution}
            onChange={(event) =>
              onChange({ allowMdxExecution: event.target.checked })
            }
          />
          Enable manual MDX execution
        </label>
        <p>
          Off by default. Approved files run only when you choose Run MDX, in a
          separate restricted process. Code can consume resources; Stop
          execution terminates it. Marka's native commands are unavailable;
          browser network and resource loads are restricted by CSP.
        </p>
        {!available && (
          <p>
            Open a workspace in the desktop app to configure execution and
            plugins.
          </p>
        )}
        {currentPath ? (
          <label className="dialog-option">
            <input
              type="checkbox"
              disabled={!available || !preferences.allowMdxExecution}
              checked={preferences.mdxExecutionFiles.includes(currentPath)}
              onChange={(event) =>
                onChange({
                  mdxExecutionFiles: event.target.checked
                    ? [...preferences.mdxExecutionFiles, currentPath]
                    : preferences.mdxExecutionFiles.filter(
                        (item) => item !== currentPath,
                      ),
                })
              }
            />
            <span>
              Allow execution for <code>{currentPath}</code>
            </span>
          </label>
        ) : (
          <p>Save and open an MDX file to approve it individually.</p>
        )}
        {preferences.mdxExecutionFiles.length > 0 && (
          <ul className="mdx-registry" aria-label="Approved MDX files">
            {preferences.mdxExecutionFiles.map((file) => (
              <li key={file}>
                <code>{file}</code>
                <button
                  type="button"
                  aria-label={`Revoke execution for ${file}`}
                  onClick={() =>
                    onChange({
                      mdxExecutionFiles: preferences.mdxExecutionFiles.filter(
                        (item) => item !== file,
                      ),
                    })
                  }
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      <fieldset className="mdx-settings" disabled={!available}>
        <legend>Local component plugins</legend>
        <p>
          Register workspace React components, then use their names as MDX tags.
          Plugin code executes only in approved manual runs. Changes stop the
          current runtime and apply on the next Run.
        </p>
        {preferences.mdxPlugins.length > 0 && (
          <ul className="mdx-registry" aria-label="Registered MDX plugins">
            {preferences.mdxPlugins.map((plugin) => (
              <li key={plugin.name}>
                <span>
                  <strong>{plugin.name}</strong>
                  <code>
                    {plugin.path} · {plugin.exportName}
                  </code>
                </span>
                <button
                  type="button"
                  aria-label={`Remove plugin ${plugin.name}`}
                  onClick={() =>
                    onChange({
                      mdxPlugins: preferences.mdxPlugins.filter(
                        (item) => item.name !== plugin.name,
                      ),
                    })
                  }
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <div
          className="mdx-plugin-fields"
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              event.target instanceof HTMLInputElement
            ) {
              event.preventDefault();
              register();
            }
          }}
        >
          <label className="dialog-field">
            Component name
            <input
              value={name}
              placeholder="Counter"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="dialog-field">
            Component file
            <input
              value={path}
              placeholder="components/Counter.tsx"
              onChange={(event) => setPath(event.target.value)}
            />
          </label>
          <label className="dialog-field">
            Export name
            <input
              value={exportName}
              onChange={(event) => setExportName(event.target.value)}
            />
          </label>
          <button type="button" onClick={register}>
            Register component
          </button>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </fieldset>
    </>
  );
}
