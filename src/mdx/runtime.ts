import { getCurrentWindow } from "@tauri-apps/api/window";
import runtimeUrl from "../generated/mdx-sandbox.js?url&no-inline";
import type { MdxRunPayload } from "../lib/contracts";
import { PAYLOAD_LIMIT } from "./protocol";
import "./runtime.css";

declare global {
  interface Window {
    __MARKA_MDX_PAYLOAD__?: MdxRunPayload;
  }
}
const payload = window.__MARKA_MDX_PAYLOAD__;
delete window.__MARKA_MDX_PAYLOAD__;
const title = document.querySelector("h1")!;
const status = document.querySelector<HTMLElement>("#status")!;
const close = document.querySelector<HTMLButtonElement>("#close")!;
let frame: HTMLIFrameElement | undefined;
let startupTimer: number | undefined;
let sent = false;
close.onclick = () => {
  frame?.remove();
  clearTimeout(startupTimer);
  status.textContent = "Stopped. Close this window, or use Stop in Marka.";
  void getCurrentWindow()
    .close()
    .catch((error) => {
      const message =
        typeof error === "object" && error !== null && "message" in error
          ? String(error.message)
          : String(error);
      status.textContent = `Could not close runtime: ${message}. Use Stop in Marka.`;
      status.setAttribute("role", "alert");
    });
};
try {
  if (
    !payload ||
    typeof payload.code !== "string" ||
    typeof payload.title !== "string" ||
    !["light", "dark"].includes(payload.theme)
  )
    throw new Error("Missing or invalid MDX runtime payload.");
  if (new TextEncoder().encode(payload.code).length > PAYLOAD_LIMIT)
    throw new Error("MDX runtime payload exceeds 32 MiB.");
  title.textContent = payload.title;
  document.documentElement.dataset.theme = payload.theme;
  frame = document.createElement("iframe");
  frame.title = "Executable MDX — isolated runtime";
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const escape = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;");
  const policy = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escape(policy)}"><meta name="referrer" content="no-referrer"></head><body><script nonce="${nonce}" src="${escape(new URL(runtimeUrl, location.href).href)}"></script></body></html>`;
  window.addEventListener("message", (event) => {
    if (event.source !== frame?.contentWindow || event.origin !== "null")
      return;
    const data: unknown = event.data;
    if (
      !data ||
      typeof data !== "object" ||
      !("markaMdx" in data) ||
      data.markaMdx !== true ||
      !("kind" in data)
    )
      return;
    if (data.kind === "boot" && !sent) {
      sent = true;
      frame.contentWindow?.postMessage(
        { kind: "marka-mdx-program", code: payload.code },
        "*",
      );
      return;
    }
    if (
      data.kind === "error" &&
      "message" in data &&
      typeof data.message === "string"
    ) {
      clearTimeout(startupTimer);
      status.textContent = `Error: ${data.message.slice(0, 4000)}`;
      status.setAttribute("role", "alert");
    } else if (
      data.kind === "ready" &&
      status.getAttribute("role") !== "alert"
    ) {
      clearTimeout(startupTimer);
      status.textContent =
        "Running in an isolated process. Use Stop in Marka if this window becomes unresponsive.";
    }
  });
  startupTimer = window.setTimeout(() => {
    status.textContent =
      "Runtime did not finish starting. Use Stop in Marka and inspect the document or plugin code.";
    status.setAttribute("role", "alert");
  }, 15000);
  document.querySelector("#content")!.append(frame);
} catch (error) {
  status.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
  status.setAttribute("role", "alert");
}
window.addEventListener("pagehide", () => clearTimeout(startupTimer));
