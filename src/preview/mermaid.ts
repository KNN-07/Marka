import DOMPurify from "dompurify";
let queue: Promise<unknown> = Promise.resolve();
let sequence = 0;
export function renderMermaid(
  source: string,
  theme: "light" | "dark",
  isCurrent: () => boolean,
): Promise<string> {
  const task = queue.then(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (!isCurrent()) throw new Error("Superseded diagram.");
    if (source.length > 10000)
      throw new Error("Mermaid source exceeds 10,000 characters.");
    if (/%%\s*\{/.test(source) || /^\s*---(?:\r?\n|$)/.test(source))
      throw new Error(
        "Mermaid configuration directives and frontmatter are not permitted.",
      );
    // The approved offline preview loads this large renderer only when a diagram exists.
    const { default: mermaid } = await import("mermaid");
    if (!isCurrent()) throw new Error("Superseded diagram.");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      htmlLabels: false,
      maxTextSize: 10000,
      maxEdges: 200,
      theme: theme === "dark" ? "dark" : "default",
      secure: [
        "secure",
        "securityLevel",
        "startOnLoad",
        "htmlLabels",
        "maxTextSize",
        "maxEdges",
        "theme",
      ],
    });
    const container = document.createElement("div");
    container.setAttribute("aria-hidden", "true");
    Object.assign(container.style, {
      position: "fixed",
      left: "-20000px",
      top: "0",
      width: "1200px",
      visibility: "hidden",
      pointerEvents: "none",
    });
    document.body.append(container);
    try {
      const result = await mermaid.render(
        `markaDiagram${++sequence}`,
        source,
        container,
      );
      if (!isCurrent()) throw new Error("Superseded diagram.");
      const svg = DOMPurify.sanitize(result.svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: [
          "script",
          "foreignObject",
          "iframe",
          "object",
          "embed",
          "a",
          "image",
        ],
        RETURN_DOM: true,
      });
      if (!(svg instanceof Element))
        throw new Error("Diagram renderer did not produce an SVG element.");
      for (const node of [svg, ...svg.querySelectorAll("*")]) {
        for (const attribute of [...node.attributes]) {
          if (
            /^on/i.test(attribute.name) ||
            (/^(?:href|xlink:href)$/i.test(attribute.name) &&
              !attribute.value.startsWith("#")) ||
            /url\(\s*['"]?(?!#)/i.test(attribute.value)
          )
            node.removeAttribute(attribute.name);
        }
      }
      for (const style of svg.querySelectorAll("style"))
        style.textContent = (style.textContent ?? "")
          .replace(/@import[^;]+;?/gi, "")
          .replace(/url\([^)]*\)/gi, (value) =>
            /^url\(\s*['"]?#/.test(value) ? value : "none",
          );
      const markup =
        svg instanceof HTMLBodyElement
          ? svg.innerHTML
          : new XMLSerializer().serializeToString(svg);
      if (new TextEncoder().encode(markup).length > 8 * 1024 * 1024)
        throw new Error("Rendered diagram exceeds 8 MiB.");
      const bytes = new TextEncoder().encode(markup);
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 32768)
        binary += String.fromCharCode(
          ...bytes.subarray(offset, offset + 32768),
        );
      return `data:image/svg+xml;base64,${btoa(binary)}`;
    } finally {
      container.remove();
    }
  });
  queue = task.catch(() => undefined);
  return task;
}
