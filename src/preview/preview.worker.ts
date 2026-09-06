import {
  prepareRender,
  finishRender,
  failedResult,
  type RenderInput,
  type ResourcesInput,
  type PendingRender,
  type ResourceOutput,
} from "./pipeline";
let pending: PendingRender | null = null;
let generation = 0;
self.onmessage = async (event: MessageEvent<RenderInput | ResourcesInput>) => {
  const input = event.data;
  if (input.kind === "render") {
    const current = ++generation;
    pending = null;
    try {
      const prepared = await prepareRender(input);
      if (current !== generation) return;
      if ("kind" in prepared) self.postMessage(prepared);
      else if (prepared.requests.length) {
        pending = prepared;
        self.postMessage({
          kind: "requests",
          documentId: input.documentId,
          version: input.version,
          requests: prepared.requests,
        } satisfies ResourceOutput);
      } else {
        const result = await finishRender(prepared);
        if (current === generation) self.postMessage(result);
      }
    } catch (error) {
      if (current === generation) self.postMessage(failedResult(input, error));
    }
  } else if (
    pending &&
    pending.input.documentId === input.documentId &&
    pending.input.version === input.version
  ) {
    const tree = pending,
      current = generation;
    pending = null;
    const result = await finishRender(tree, input.resources);
    if (current === generation) self.postMessage(result);
  }
};
