import { compile } from "@mdx-js/mdx";
import { transform } from "@babel/standalone";
import type { TransformOptions } from "@babel/core";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkFrontmatter from "remark-frontmatter";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import { resolveImagePath } from "../preview/resources";
import type { MdxModule } from "../lib/contracts";
import {
  BUILTINS,
  SOURCE_LIMIT,
  GRAPH_LIMIT,
  MODULE_LIMIT,
  PLUGIN_LIMIT,
  PAYLOAD_LIMIT,
  type CompileInput,
  type Resource,
  type ToWorker,
  type FromWorker,
} from "./protocol";

const pending = new Map<
  number,
  { resolve(value: MdxModule | string): void; reject(error: Error): void }
>();
let sequence = 0;
function resource(request: Resource): Promise<MdxModule | string> {
  // ES2022 is the minimum supported webview; Promise.withResolvers is not available there.
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    postMessage({
      kind: "resource",
      id,
      resource: request,
    } satisfies FromWorker);
  });
}
const encoder = new TextEncoder();

type AstNode = {
  type: string;
  source?: { value: string };
  value?: string;
  name?: string;
  importKind?: string;
  exportKind?: string;
  loc?: { start: { line: number; column: number } };
  [key: string]: unknown;
};
function inspect(
  node: AstNode,
  imports: Set<string>,
  filename: string,
  functionDepth = 0,
) {
  const fail = (message: string) => {
    throw new Error(
      `${filename}:${node.loc?.start.line ?? 1}:${(node.loc?.start.column ?? 0) + 1}: ${message}`,
    );
  };
  if (
    node.type === "ImportExpression" ||
    node.type === "Import" ||
    node.type === "TSImportEqualsDeclaration" ||
    node.type === "TSExternalModuleReference"
  )
    fail(
      "Dynamic imports and CommonJS loading are not supported; use static ESM imports.",
    );
  if (node.type === "MetaProperty")
    fail("import.meta is not supported in executable documents.");
  if (node.type === "Identifier" && node.name === "require")
    fail("CommonJS require is not supported; use static ESM imports.");
  if (
    !functionDepth &&
    (node.type === "AwaitExpression" ||
      (node.type === "ForOfStatement" && node.await))
  )
    fail(
      "Top-level await is not supported; await inside an async function instead.",
    );
  if (node.type === "InterpreterDirective")
    fail("Executable modules must not contain a shebang.");
  const childDepth =
    functionDepth + (/Function|Method/.test(node.type) ? 1 : 0);
  if (
    (node.type === "ImportDeclaration" && node.importKind !== "type") ||
    ((node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration") &&
      node.exportKind !== "type")
  ) {
    if (node.source) imports.add(node.source.value);
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "comments" || key === "tokens") continue;
    if (Array.isArray(value)) {
      for (const child of value)
        if (child && typeof child === "object" && "type" in child)
          inspect(child as AstNode, imports, filename, childDepth);
    } else if (value && typeof value === "object" && "type" in value)
      inspect(value as AstNode, imports, filename, childDepth);
  }
}

async function compileGraph(input: CompileInput) {
  if (!/\.mdx$/i.test(input.path))
    throw new Error("Executable entry must be a saved .mdx file.");
  if (input.plugins.length > PLUGIN_LIMIT)
    throw new Error("At most 32 local component plugins are supported.");
  const names = new Set<string>(["Callout", "Badge", "Tabs", "Tab"]);
  for (const plugin of input.plugins) {
    if (!/^[A-Z][A-Za-z0-9]{0,63}$/.test(plugin.name) || names.has(plugin.name))
      throw new Error(
        `Invalid, reserved or duplicate component name: ${plugin.name}`,
      );
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(plugin.exportName || "default"))
      throw new Error(`Invalid export name for ${plugin.name}.`);
    if (!/\.(jsx|tsx|mdx)$/i.test(plugin.path))
      throw new Error(
        `Plugin ${plugin.name} must be a local .jsx, .tsx or .mdx file.`,
      );
    names.add(plugin.name);
  }
  let graphBytes = 0;
  let payloadBytes = 0;
  const modules = new Map<
    string,
    { code: string; dependencies: Record<string, string> }
  >();
  const images = new Map<string, string>();
  const add = async ({ path, source }: MdxModule): Promise<string> => {
    if (modules.has(path)) return path;
    const bytes = encoder.encode(source).length;
    if (bytes > SOURCE_LIMIT) throw new Error(`${path}: source exceeds 5 MiB.`);
    graphBytes += bytes;
    if (graphBytes > GRAPH_LIMIT)
      throw new Error("Module graph exceeds 20 MiB.");
    if (modules.size >= MODULE_LIMIT)
      throw new Error("Module graph exceeds 128 modules.");
    const item = {
      code: "",
      dependencies: Object.create(null) as Record<string, string>,
    };
    modules.set(path, item); // Reserve before descending so cycles resolve through the runtime cache.
    try {
      let javascript = source;
      if (/\.json$/i.test(path)) {
        item.code = `module.exports = ${JSON.stringify(JSON.parse(source))};`;
      } else {
        if (!/\.(mdx|jsx|tsx|js|ts)$/i.test(path))
          throw new Error(
            "Only MDX, JSX, TSX, JS, TS and JSON modules are supported.",
          );
        if (/\.mdx$/i.test(path)) {
          const resolveImages = () => async (tree: unknown) => {
            const walk = async (node: {
              type?: string;
              tagName?: string;
              properties?: Record<string, unknown>;
              children?: unknown[];
            }) => {
              if (
                node.type === "element" &&
                node.tagName === "img" &&
                typeof node.properties?.src === "string"
              ) {
                const imagePath = resolveImagePath(path, node.properties.src);
                let url = images.get(imagePath);
                if (!url) {
                  url = (await resource({
                    kind: "image",
                    path: imagePath,
                  })) as string;
                  payloadBytes += encoder.encode(url).length;
                  if (payloadBytes > PAYLOAD_LIMIT)
                    throw new Error("Images exceed 32 MiB payload limit.");
                  images.set(imagePath, url);
                }
                node.properties.src = url;
              }
              for (const child of node.children ?? [])
                await walk(child as Parameters<typeof walk>[0]);
            };
            await walk(tree as Parameters<typeof walk>[0]);
          };
          javascript = String(
            await compile(
              { value: source, path },
              {
                outputFormat: "program",
                providerImportSource: "@mdx-js/react",
                remarkPlugins: [remarkGfm, remarkMath, remarkFrontmatter],
                rehypePlugins: [
                  [
                    rehypeHighlight,
                    {
                      detect: false,
                      ignoreMissing: true,
                      plainText: ["text", "txt", "mermaid", "math"],
                    },
                  ],
                  [
                    rehypeKatex,
                    {
                      trust: false,
                      strict: "warn",
                      maxExpand: 1000,
                      maxSize: 20,
                      macros: {},
                    },
                  ],
                  resolveImages,
                ],
              },
            ),
          );
        }
        const presets: TransformOptions["presets"] = [
          ["react", { runtime: "automatic" }],
        ];
        if (/\.tsx?$/i.test(path))
          presets.push([
            "typescript",
            {
              allExtensions: true,
              isTSX: /\.tsx$/i.test(path),
              onlyRemoveTypeImports: true,
            },
          ]);
        const parsed = transform(javascript, {
          filename: path,
          presets,
          ast: true,
          code: true,
          sourceType: "module",
        });
        const imports = new Set<string>();
        inspect(parsed.ast as unknown as AstNode, imports, path);
        for (const specifier of imports) {
          if (Object.hasOwn(BUILTINS, specifier)) {
            item.dependencies[specifier] = specifier;
            continue;
          }
          if (
            !/^\.\.?\//.test(specifier) ||
            /[\\:?#\u0000-\u001f]/.test(specifier)
          )
            throw new Error(
              `Unsupported import ${JSON.stringify(specifier)}; only relative files and fixed React/MDX builtins are allowed.`,
            );
          const dependency = (await resource({
            kind: "module",
            importer: path,
            specifier,
          })) as MdxModule;
          item.dependencies[specifier] = await add(
            dependency.path === input.path
              ? { path: input.path, source: input.source }
              : dependency,
          );
        }
        item.code = transform(parsed.code!, {
          filename: path,
          sourceType: "module",
          plugins: ["transform-modules-commonjs"],
        }).code!;
      }
      payloadBytes += encoder.encode(item.code).length;
      if (payloadBytes > PAYLOAD_LIMIT)
        throw new Error("Compiled payload exceeds 32 MiB.");
      return path;
    } catch (error) {
      throw new Error(
        `${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const entry = await add({ path: input.path, source: input.source });
  const plugins: { name: string; path: string; exportName: string }[] = [];
  for (const plugin of input.plugins) {
    const module = (await resource({
      kind: "module",
      importer: null,
      specifier: plugin.path,
    })) as MdxModule;
    plugins.push({
      name: plugin.name,
      path: await add(
        module.path === input.path
          ? { path: input.path, source: input.source }
          : module,
      ),
      exportName: plugin.exportName || "default",
    });
  }
  const factories = [...modules]
    .map(
      ([path, item]) =>
        `${JSON.stringify(path)}:function(module,exports,require){\n${item.code}\n}`,
    )
    .join(",\n");
  const dependencies = Object.fromEntries(
    [...modules].map(([path, item]) => [path, item.dependencies]),
  );
  const code = `window.__MARKA_MDX_START__({${factories}},${JSON.stringify(dependencies)},${JSON.stringify(entry)},${JSON.stringify(plugins)},${JSON.stringify(input.theme)});`;
  if (encoder.encode(code).length > PAYLOAD_LIMIT)
    throw new Error("Compiled payload exceeds 32 MiB.");
  return { title: input.path, code, theme: input.theme };
}

self.onmessage = async ({ data }: MessageEvent<ToWorker>) => {
  if (data.kind === "resource") {
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data.value!);
    return;
  }
  try {
    postMessage({
      kind: "done",
      payload: await compileGraph(data.input),
    } satisfies FromWorker);
  } catch (error) {
    postMessage({
      kind: "error",
      error: error instanceof Error ? error.message : String(error),
    } satisfies FromWorker);
  }
};
