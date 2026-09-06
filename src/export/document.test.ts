// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { buildExportHtml, exportDocument } from "./document";

describe("standalone document export", () => {
  it("exports every Tabs panel as a titled section and repairs local navigation", () => {
    const html =
      '<fieldset class="mdx-tabs"><div class="mdx-tab"><input type="radio" checked><label>First</label><div class="mdx-panel"><p>Alpha</p></div></div><div class="mdx-tab"><input type="radio"><label>Second</label><div class="mdx-panel"><p>Beta</p></div></div></fieldset><a href="about:srcdoc#note">Footnote</a><p id="note">Note</p>';
    const output = new DOMParser().parseFromString(
      buildExportHtml("A & B", html),
      "text/html",
    );
    expect(
      [...output.querySelectorAll(".export-tab")].map(
        (section) => section.textContent,
      ),
    ).toEqual(["FirstAlpha", "SecondBeta"]);
    expect(output.querySelector("input")).toBeNull();
    expect(output.querySelector("a")?.getAttribute("href")).toBe("#note");
    expect(output.title).toBe("A & B");
  });

  it("keeps TeX once, code whitespace, list state and table boundaries in text", async () => {
    const html =
      '<h1>Features</h1><p>Value <span class="katex"><span class="katex-mathml"><math><semantics><mi>x</mi><annotation encoding="application/x-tex">x^2</annotation></semantics></math></span><span class="katex-html">duplicate visual text</span></span>.</p><ul><li><input type="checkbox" checked>Done</li></ul><pre><code><span>  const x = 2;</span>\n  x++;</code></pre><table><tr><th>A</th><th>B</th></tr><tr><td>One</td><td>Two</td></tr></table>';
    const result = await exportDocument({
      format: "txt",
      title: "Features",
      html,
    });
    const text = new TextDecoder().decode(result.bytes);
    expect(text).toContain("# Features");
    expect(text).toContain("Value $x^2$.");
    expect(text).not.toContain("duplicate visual text");
    expect(text).toContain("[x] Done");
    expect(text).toContain("  const x = 2;\n  x++;");
    expect(text).toContain("A\tB\nOne\tTwo");
  });

  it("keeps Callout titles separate from their prose", async () => {
    const result = await exportDocument({
      format: "txt",
      title: "Callout",
      html: '<aside class="callout"><strong>Important</strong>Keep the source unchanged.</aside>',
    });
    expect(new TextDecoder().decode(result.bytes)).toContain(
      "Important\n\nKeep the source unchanged.",
    );
  });

  it("rejects unresolved resources instead of silently omitting images", async () => {
    await expect(
      exportDocument({
        format: "docx",
        title: "Missing",
        html: '<img src="https://example.com/a.png" alt="Diagram">',
      }),
    ).rejects.toThrow("not embedded");
  });
});
