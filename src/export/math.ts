import { mathjax } from "mathjax-full/js/mathjax.js";
import { MathML } from "mathjax-full/js/input/mathml.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const converter = mathjax.document("", {
  InputJax: new MathML(),
  OutputJax: new SVG({ fontCache: "none" }),
});

export function mathSvg(math: string): string {
  const output = converter.convert(math, {
    display: true,
    em: 16,
    ex: 8,
    containerWidth: 640,
  });
  const svg = adaptor.tags(output, "svg")[0];
  if (
    !svg ||
    adaptor.tags(output, "merror").length ||
    adaptor.outerHTML(output).includes('data-mml-node="merror"')
  ) {
    throw new Error(
      "An equation could not be converted. Correct its math syntax and retry.",
    );
  }
  const viewBox = (adaptor.getAttribute(svg, "viewBox") ?? "")
    .split(/\s+/)
    .map(Number);
  if (
    viewBox.length !== 4 ||
    !viewBox.every(Number.isFinite) ||
    viewBox[2] <= 0 ||
    viewBox[3] <= 0
  )
    throw new Error("An equation has invalid image dimensions.");
  adaptor.setAttribute(
    svg,
    "width",
    String(Math.max(1, Math.ceil(viewBox[2] * 0.016))),
  );
  adaptor.setAttribute(
    svg,
    "height",
    String(Math.max(1, Math.ceil(viewBox[3] * 0.016))),
  );
  adaptor.setAttribute(svg, "color", "#26323b");
  return adaptor.outerHTML(svg);
}
