import { describe, expect, it } from "vitest";
import { prepareRender, renderDocument, type RenderInput } from "./pipeline";
import { resolveImagePath } from "./resources";
const input = (source: string, format: "md" | "mdx" = "md"): RenderInput => ({
  kind: "render",
  documentId: "test",
  version: 1,
  source,
  format,
  theme: "light",
});
describe("safe preview pipeline", () => {
  it("renders common Markdown and keeps deterministic outline source offsets", async () => {
    const source =
      "---\ntitle: Hidden\n---\n# Same\n\n# Same\n\n- [x] Done\n- [ ] Pending\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```js\nconst answer = 42;\n```\n\n```unknown-grammar\nplain\n```\n\nA note[^n].\n\n[^n]: Note content.";
    const result = await renderDocument(input(source));
    expect(result.html).toContain("<table>");
    expect(result.html).toContain("checked");
    expect(result.html).toContain("disabled");
    expect(result.html).toContain("hljs-keyword");
    expect(result.html).toContain("plain");
    expect(result.html).not.toContain("title: Hidden");
    expect(result.headings).toEqual([
      {
        id: "marka-heading-same",
        text: "Same",
        depth: 1,
        from: source.indexOf("# Same"),
      },
      {
        id: "marka-heading-same-2",
        text: "Same",
        depth: 1,
        from: source.lastIndexOf("# Same"),
      },
    ]);
    expect(result.html).toContain('href="about:srcdoc#marka-footnote-fn-n"');
    expect(result.html).toContain('id="marka-footnote-fn-n"');
  });
  it("renders bundled components, literal children and native radio controls", async () => {
    const result = await renderDocument(
      input(
        '<Callout type="tip" title="Local">**Works** offline.</Callout>\n\n<Tabs defaultIndex={1}>\n{/* inert panel comment */}\n<Tab title="First">One</Tab>\n<Tab title="Second">Two</Tab>\n</Tabs>\n\n{3}\n\n{false}\n\n{/* inert */}',
        "mdx",
      ),
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.html).toContain("<strong>Works</strong>");
    expect(result.html).toContain('type="radio"');
    const radios = [...result.html!.matchAll(/<input[^>]+>/g)].map(
      (match) => match[0],
    );
    for (const radio of radios) expect(radio).not.toContain("disabled");
    expect(radios[0]).not.toContain("checked");
    expect(radios[1]).toContain("checked");
    const ids = [...result.html!.matchAll(/<input[^>]*id="([^"]+)"/g)].map(
      (match) => match[1],
    );
    for (const id of ids) expect(result.html).toContain(`for="${id}"`);
    expect(result.html).toContain("3");
    expect(result.html).not.toContain("false");
  });
  it.each([
    "import X from './x'",
    "{(() => window.pwned = true)()}",
    "<Unknown />",
    "<Callout {...props} />",
    "<Callout onClick={() => 1} />",
    '<div style="color:red" />',
    '<Tab title="orphan">No</Tab>',
    '<Tabs defaultIndex={2}><Tab title="Only">No</Tab></Tabs>',
    '<Tabs defaultIndex={null}><Tab title="Only">No</Tab></Tabs>',
    "<script>alert(1)</script>",
    "<Thing.Member />",
  ])("rejects executable or unsupported MDX: %s", async (source) => {
    const result = await renderDocument(input(source, "mdx"));
    expect(result.html).toBeNull();
    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.severity === "error" &&
          diagnostic.from >= 0 &&
          diagnostic.to >= diagnostic.from,
      ),
    ).toBe(true);
  });
  it("does not interpret Markdown braces and strips active HTML/navigation", async () => {
    const result = await renderDocument(
      input(
        '{1 + 1}\n\n<script>window.pwned=true</script>\n\n<img src="https://evil.example/a.png" onerror="alert(1)">\n\n<a href="javascript:alert(1)" onclick="alert(1)" id="owned" style="color:red">Readable</a>\n\n<iframe src="https://evil.example"></iframe>',
      ),
    );
    expect(result.html).toContain("{1 + 1}");
    expect(result.html).toContain("Readable");
    expect(result.html).not.toMatch(
      /<script|<iframe|onerror=|onclick=|javascript:|id="[^"]*owned|style="color:red/,
    );
  });
  it("never requests privileged schemes or encoded path attacks", async () => {
    for (const path of [
      "https://evil.example/a.png",
      "//evil.example/a.png",
      "data:image/png;base64,abc",
      "C:/secret.png",
      "/secret.png",
      "%2e%2e/secret.png",
      "foo\\secret.png",
    ]) {
      const result = await prepareRender(input(`![blocked](${path})`));
      if (!("kind" in result)) expect(result.requests).toEqual([]);
    }
    expect(() => resolveImagePath("file.md", "../outside.png")).toThrow(
      /escapes/,
    );
    expect(resolveImagePath("nested/file.md", "../inside.png")).toBe(
      "inside.png",
    );
  });
  it("produces accessible math, isolates errors and disables trusted commands", async () => {
    const result = await renderDocument(
      input(
        "Before $\\frac{1}{2}$ after.\n\n$$\n\\notarealcommand{x}\n$$\n\nStill here.\n\n$\\href{javascript:alert(1)}{attack}$\n\n$\\includegraphics{https://evil.example/a.png}$",
      ),
    );
    expect(result.html).toContain("<math");
    expect(result.html).toContain("katex-html");
    expect(result.html).toContain("<mfrac>");
    expect(result.html).toContain("Still here.");
    expect(result.diagnostics.some((d) => d.severity === "warning")).toBe(true);
    expect(result.html).not.toMatch(/href="javascript:|src="https:\/\/evil/);
  });
  it("does not leak macros between documents", async () => {
    await renderDocument(input("$\\gdef\\markasecret{SECRET}\\markasecret$"));
    const result = await renderDocument(input("$\\markasecret$"));
    expect(result.html).not.toContain("SECRET");
    expect(result.diagnostics.some((d) => d.severity === "warning")).toBe(true);
  });
  it("requests inert diagrams and preserves surrounding content on resource failure", async () => {
    const result = await renderDocument(
      input(
        "# Surrounding\n\n```mermaid\nflowchart LR\n A --> B\n```\n\nAfter",
      ),
    );
    expect(result.html).toContain("Surrounding");
    expect(result.html).toContain("After");
    expect(result.html).toContain("Resource unavailable");
    expect(result.diagnostics[0].from).toBeGreaterThan(0);
  });
});
