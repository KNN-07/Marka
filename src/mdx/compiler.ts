import type { MdxRunPayload } from "../lib/contracts";
import { readAsset, resolveMdxModule } from "../lib/native";
import {
  ACTIVE_TIMEOUT,
  type CompileInput,
  type FromWorker,
  type ToWorker,
} from "./protocol";

export function compileExecutableMdx(
  input: CompileInput & { signal: AbortSignal },
): Promise<MdxRunPayload> {
  return new Promise((resolve, reject) => {
    if (input.signal.aborted) {
      reject(new DOMException("Compilation cancelled", "AbortError"));
      return;
    }
    const worker = new Worker(
      new URL("./compiler.worker.ts", import.meta.url),
      { type: "module" },
    );
    let settled = false;
    let remaining = ACTIVE_TIMEOUT;
    let activeSince = performance.now();
    let timer: number;
    const finish = (error?: unknown, payload?: MdxRunPayload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal.removeEventListener("abort", abort);
      worker.terminate();
      if (error) reject(error);
      else resolve(payload!);
    };
    const abort = () =>
      finish(new DOMException("Compilation cancelled", "AbortError"));
    const arm = () => {
      activeSince = performance.now();
      timer = window.setTimeout(
        () =>
          finish(
            new Error("MDX compilation exceeded 30 seconds of active work."),
          ),
        Math.max(0, remaining),
      );
    };
    input.signal.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) =>
      finish(new Error(event.message || "MDX compiler worker failed."));
    worker.onmessage = async ({ data }: MessageEvent<FromWorker>) => {
      if (settled) return;
      if (data.kind === "done") {
        finish(undefined, data.payload);
        return;
      }
      if (data.kind === "error") {
        finish(new Error(data.error));
        return;
      }
      clearTimeout(timer);
      remaining -= performance.now() - activeSince;
      const response: ToWorker = { kind: "resource", id: data.id };
      try {
        if (data.resource.kind === "module") {
          response.value = await resolveMdxModule(
            input.workspaceId,
            input.path,
            data.resource.importer,
            data.resource.specifier,
          );
        } else {
          const bytes = new Uint8Array(
            await readAsset(input.workspaceId, data.resource.path),
          );
          if (bytes.byteLength > 8 * 1024 * 1024)
            throw new Error("Image exceeds 8 MiB.");
          let binary = "";
          for (let i = 0; i < bytes.length; i += 32768)
            binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
          const extension = data.resource.path.split(".").pop()?.toLowerCase();
          const mime =
            extension === "jpg" || extension === "jpeg"
              ? "image/jpeg"
              : `image/${extension}`;
          response.value = `data:${mime};base64,${btoa(binary)}`;
        }
      } catch (error) {
        response.error =
          typeof error === "object" && error !== null && "message" in error
            ? String(error.message)
            : String(error);
      }
      if (!settled) {
        arm();
        worker.postMessage(response);
      }
    };
    arm();
    const { signal: _signal, ...request } = input;
    worker.postMessage({ kind: "compile", input: request } satisfies ToWorker);
  });
}
