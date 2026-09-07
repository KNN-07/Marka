import { useEffect, useRef, useState } from "react";
import type { MdxRuntimeStatus, Session } from "../lib/contracts";
import * as native from "../lib/native";
import { compileExecutableMdx } from "../mdx/compiler";
import type { DocumentTab } from "./types";

const idle: MdxRuntimeStatus = { running: false, path: null, error: null };
export function useMdxExecution(
  workspaceId: string | null,
  preferences: Session,
  theme: "light" | "dark",
  getActive: () => DocumentTab | null,
  persist: () => Promise<void>,
) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<MdxRuntimeStatus>(idle);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pending.current?.abort();
    };
  }, []);
  useEffect(() => {
    pending.current?.abort();
    if (!native.nativeAvailable) return;
    let live = true;
    void native
      .stopMdx()
      .then(() => {
        if (live) setStatus(idle);
      })
      .catch((cause) => {
        if (live) setError(cause.message ?? String(cause));
      });
    return () => {
      live = false;
      pending.current?.abort();
    };
  }, [
    workspaceId,
    preferences.allowMdxExecution,
    preferences.mdxExecutionFiles,
    preferences.mdxPlugins,
  ]);
  useEffect(() => {
    if (!status.running || !native.nativeAvailable) return;
    let live = true;
    let querying = false;
    const timer = setInterval(() => {
      if (querying) return;
      querying = true;
      void native
        .mdxRuntimeStatus()
        .then((next) => {
          if (live) {
            setStatus(next);
            if (next.error) setError(next.error);
          }
        })
        .catch((cause) => {
          if (live) setError(cause.message ?? String(cause));
        })
        .finally(() => {
          querying = false;
        });
    }, 1000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [status.running]);
  const run = async () => {
    if (pending.current) return;
    const tab = getActive();
    if (
      !native.nativeAvailable ||
      !workspaceId ||
      !tab?.path ||
      tab.format !== "mdx" ||
      !preferences.allowMdxExecution ||
      !preferences.mdxExecutionFiles.includes(tab.path)
    ) {
      setError(
        "Save an MDX file in your workspace, then enable execution and approve that file in Settings.",
      );
      return;
    }
    const source = tab.state.doc.toString();
    const path = tab.path;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError("");
    try {
      await persist();
      if (controller.signal.aborted) return;
      const payload = await compileExecutableMdx({
        workspaceId,
        path,
        source,
        plugins: preferences.mdxPlugins,
        theme,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      await native.runMdx(workspaceId, path, payload);
      if (controller.signal.aborted) {
        await native.stopMdx();
        return;
      }
      const next = await native.mdxRuntimeStatus();
      if (mounted.current) {
        setStatus(next);
        if (next.error) setError(next.error);
      }
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current)
        setError((cause as Error).message ?? String(cause));
    } finally {
      if (pending.current === controller) pending.current = null;
      if (mounted.current) setBusy(false);
    }
  };
  const stop = async () => {
    pending.current?.abort();
    try {
      await native.stopMdx();
      if (mounted.current) setStatus(idle);
    } catch (cause) {
      if (mounted.current) setError((cause as Error).message ?? String(cause));
    }
  };
  return { busy, status, error, run, stop };
}
