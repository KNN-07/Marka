import DOMPurify from "dompurify";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import printCss from "./print.css?raw";

const printButton = document.querySelector<HTMLButtonElement>("#print-action")!;
const closeButton = document.querySelector<HTMLButtonElement>("#print-close")!;
const status = document.querySelector<HTMLElement>("#print-status")!;
const surface = document.querySelector<HTMLElement>("#print-document")!;
let ready = false;
let printing = false;

function showError(error: unknown) {
  status.textContent =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String(error.message)
        : String(error);
}

async function print() {
  if (!ready || printing) return;
  printing = true;
  printButton.disabled = true;
  status.textContent = "Opening native print dialog…";
  try {
    await invoke<void>("print_current");
    status.textContent =
      "Ready to print. You can print again or close this window.";
  } catch (error) {
    showError(error);
  } finally {
    printing = false;
    printButton.disabled = false;
  }
}
window.addEventListener("marka:print", () => void print());
printButton.addEventListener("click", () => void print());
closeButton.addEventListener(
  "click",
  () => void getCurrentWindow().close().catch(showError),
);
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "p") {
    event.preventDefault();
    void print();
  }
});
// Document anchors must never navigate this IPC-enabled app-owned surface.
surface.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest("a"))
    event.preventDefault();
});

async function prepare() {
  const host = window as Window & {
    __MARKA_PRINT__?: { title: string; html: string };
  };
  const payload = host.__MARKA_PRINT__;
  delete host.__MARKA_PRINT__;
  if (
    !payload ||
    typeof payload.title !== "string" ||
    typeof payload.html !== "string"
  ) {
    throw new Error("No print document was supplied. Open Print from Marka.");
  }
  if (
    new TextEncoder().encode(payload.html).byteLength > 64 * 1024 * 1024 ||
    payload.title.length > 2048
  ) {
    throw new Error("Print document exceeds the permitted size.");
  }
  document.title = `Print — ${payload.title}`;
  document.querySelector("#print-title")!.textContent = payload.title;
  // Only the main command can supply this app-generated standalone document.
  // Parsing is inert; document scripts, metadata, and navigation are never imported.
  const parsed = new DOMParser().parseFromString(payload.html, "text/html");
  const main = parsed.body.querySelector("main");
  if (!main) throw new Error("Print document is missing its content.");
  for (const source of parsed.head.querySelectorAll("style")) {
    const style = document.createElement("style");
    style.textContent = source.textContent;
    document.head.append(style);
  }
  const styles = document.createElement("style");
  styles.textContent = printCss;
  document.head.append(styles);
  const safe = DOMPurify.sanitize(main.outerHTML, {
    RETURN_DOM_FRAGMENT: true,
    // KaTeX uses generated SVG paths for radicals and stretchy delimiters.
    FORBID_TAGS: [
      "script",
      "style",
      "iframe",
      "object",
      "embed",
      "form",
      "base",
      "link",
      "meta",
      "foreignObject",
    ],
    FORBID_ATTR: ["srcset", "action", "formaction", "target"],
  });
  for (const element of safe.querySelectorAll(
    "[href], [src], [xlink\\:href]",
  )) {
    element.removeAttribute("href");
    element.removeAttribute("xlink:href");
    if (
      element.hasAttribute("src") &&
      !(
        element instanceof HTMLImageElement &&
        /^data:image\/(?:png|jpeg|gif|webp|svg\+xml)[;,]/i.test(
          element.getAttribute("src")!,
        )
      )
    ) {
      element.removeAttribute("src");
    }
  }
  // WebKit can ignore break-after on headings. Keep each introduction together
  // instead; oversized groups may still paginate normally.
  const headings = safe.querySelectorAll("h1, h2, h3, h4, h5, h6");
  for (let index = headings.length - 1; index >= 0; index--) {
    const heading = headings[index];
    const next = heading.nextElementSibling;
    if (!next) continue;
    const group = document.createElement("div");
    group.className = "print-section-start";
    heading.before(group);
    let node: ChildNode | null = heading;
    while (node) {
      const following: ChildNode | null = node.nextSibling;
      group.append(node);
      if (node === next) break;
      node = following;
    }
  }
  surface.replaceChildren(safe);
  await Promise.all([
    document.fonts.ready,
    ...Array.from(surface.querySelectorAll("img"), async (image) => {
      if (!image.complete)
        await new Promise<void>((resolve, reject) => {
          image.addEventListener("load", () => resolve(), { once: true });
          image.addEventListener(
            "error",
            () =>
              reject(
                new Error(
                  "An image could not be prepared for printing. Close and retry Print.",
                ),
              ),
            { once: true },
          );
        });
      if (!image.naturalWidth)
        throw new Error(
          "An image could not be prepared for printing. Close and retry Print.",
        );
    }),
  ]);
  ready = true;
  printButton.disabled = false;
  status.textContent = "Ready. Print opens your system print dialog.";
  printButton.focus();
}
void prepare().catch(showError);
