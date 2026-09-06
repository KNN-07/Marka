// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { undo } from "@codemirror/commands";
import type { FileSnapshot } from "../lib/contracts";
import * as native from "../lib/native";
import { useDocuments } from "./useDocuments";
import { isDirty } from "./types";

vi.mock("../lib/native", () => ({
  readDocument: vi.fn(),
  writeDocument: vi.fn(),
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(native.readDocument).mockResolvedValue({
    path: "note.md",
    text: "original",
    revision: "r0",
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("retained document lifecycle", () => {
  it("keeps newer edits dirty until their serialized save completes", async () => {
    const first = deferred<FileSnapshot>(),
      second = deferred<FileSnapshot>();
    vi.mocked(native.writeDocument)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() =>
      useDocuments("workspace", "light", true),
    );
    await act(async () => {
      await result.current.openDocument("note.md");
    });
    act(() => {
      const tab = result.current.active!;
      result.current.updateState(
        tab.id,
        tab.state.update({
          changes: { from: tab.state.doc.length, insert: " one" },
        }).state,
        true,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });
    act(() => {
      const tab = result.current.active!;
      result.current.updateState(
        tab.id,
        tab.state.update({
          changes: { from: tab.state.doc.length, insert: " two" },
        }).state,
        true,
      );
    });
    await act(async () => {
      first.resolve({ path: "note.md", text: "original one", revision: "r1" });
      await first.promise;
    });
    expect(isDirty(result.current.active!)).toBe(true);
    expect(result.current.active!.state.doc.toString()).toBe(
      "original one two",
    );
    expect(result.current.active!.status).toBe("Saving");
    await act(async () => {
      second.resolve({
        path: "note.md",
        text: "original one two",
        revision: "r2",
      });
      await second.promise;
    });
    expect(isDirty(result.current.active!)).toBe(false);
    expect(result.current.active!.status).toBe("Saved");
  });

  it("retains independent undo when changing tabs, theme, and wrapping", () => {
    const { result, rerender } = renderHook(
      ({ theme, wrap }: { theme: "light" | "dark"; wrap: boolean }) =>
        useDocuments(null, theme, wrap),
      { initialProps: { theme: "light", wrap: true } },
    );
    let firstId = "",
      secondId = "";
    act(() => {
      firstId = result.current.newDocument("md").id;
    });
    act(() => {
      const tab = result.current.active!;
      result.current.updateState(
        tab.id,
        tab.state.update({ changes: { from: 0, insert: "first" } }).state,
        true,
      );
    });
    act(() => {
      secondId = result.current.newDocument("mdx").id;
    });
    act(() => {
      const tab = result.current.active!;
      result.current.updateState(
        tab.id,
        tab.state.update({ changes: { from: 0, insert: "second" } }).state,
        true,
      );
    });
    rerender({ theme: "dark", wrap: false });
    act(() => {
      result.current.activate(firstId);
    });
    act(() => {
      const tab = result.current.active!;
      undo({
        state: tab.state,
        dispatch: (tr) =>
          result.current.updateState(tab.id, tr.state, tr.docChanged),
      });
    });
    expect(result.current.active!.state.doc.toString()).toBe("");
    act(() => {
      result.current.activate(secondId);
    });
    expect(result.current.active!.state.doc.toString()).toBe("second");
    act(() => {
      const tab = result.current.active!;
      undo({
        state: tab.state,
        dispatch: (tr) =>
          result.current.updateState(tab.id, tr.state, tr.docChanged),
      });
    });
    expect(result.current.active!.state.doc.toString()).toBe("");
  });

  it.each(["CONFLICT", "IO"])(
    "preserves the editable buffer after %s and does not autosave over it",
    async (code) => {
      vi.mocked(native.writeDocument).mockRejectedValue({
        code,
        message: "Disk refused save",
      });
      const { result } = renderHook(() =>
        useDocuments("workspace", "light", true),
      );
      await act(async () => {
        await result.current.openDocument("note.md");
      });
      act(() => {
        const tab = result.current.active!;
        result.current.updateState(
          tab.id,
          tab.state.update({ changes: { from: 0, insert: "my edit " } }).state,
          true,
        );
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(750);
      });
      expect(result.current.active!.status).toBe(
        code === "CONFLICT" ? "Conflict" : "Error",
      );
      expect(result.current.active!.state.doc.toString()).toBe(
        "my edit original",
      );
      expect(isDirty(result.current.active!)).toBe(true);
      act(() => {
        const tab = result.current.active!;
        result.current.updateState(
          tab.id,
          tab.state.update({ changes: { from: 0, insert: "still editable " } })
            .state,
          true,
        );
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(result.current.active!.state.doc.toString()).toBe(
        "still editable my edit original",
      );
      expect(result.current.active!.status).toBe(
        code === "CONFLICT" ? "Conflict" : "Error",
      );
    },
  );

  it("does not adopt failed Save As identity and preserves untitled through folder selection", async () => {
    vi.mocked(native.writeDocument).mockRejectedValueOnce({
      code: "ALREADY_EXISTS",
      message: "Already exists",
    });
    const initialProps: { root: string | null } = { root: null };
    const { result, rerender } = renderHook(
      ({ root }: { root: string | null }) => useDocuments(root, "light", true),
      { initialProps },
    );
    act(() => {
      result.current.newDocument("mdx");
    });
    act(() => {
      const tab = result.current.active!;
      result.current.updateState(
        tab.id,
        tab.state.update({
          changes: { from: 0, insert: "<Badge>mine</Badge>" },
        }).state,
        true,
      );
    });
    rerender({ root: "workspace" });
    await act(async () => {
      expect(
        await result.current.save(result.current.activeId!, "existing.mdx"),
      ).toBe(false);
    });
    expect(result.current.active!.path).toBeNull();
    expect(result.current.active!.state.doc.toString()).toBe(
      "<Badge>mine</Badge>",
    );
    expect(isDirty(result.current.active!)).toBe(true);
  });

  it("refresh reloads clean disk changes but preserves dirty edits as conflicts", async () => {
    const { result } = renderHook(() =>
      useDocuments("workspace", "light", true),
    );
    await act(async () => {
      await result.current.openDocument("note.md");
    });
    vi.mocked(native.readDocument).mockResolvedValue({
      path: "note.md",
      text: "external",
      revision: "r1",
    });
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.active!.state.doc.toString()).toBe("external");
    act(() => {
      const tab = result.current.active!;
      result.current.updateState(
        tab.id,
        tab.state.update({ changes: { from: 0, insert: "local " } }).state,
        true,
      );
    });
    vi.mocked(native.readDocument).mockResolvedValue({
      path: "note.md",
      text: "new disk",
      revision: "r2",
    });
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.active!.state.doc.toString()).toBe("local external");
    expect(result.current.active!.status).toBe("Conflict");
  });

  it("discards a save completion after clear and a workspace generation change", async () => {
    const save = deferred<FileSnapshot>();
    vi.mocked(native.writeDocument).mockReturnValue(save.promise);
    const { result, rerender } = renderHook(
      ({ root }) => useDocuments(root, "light", true),
      { initialProps: { root: "first" } },
    );
    await act(async () => {
      await result.current.openDocument("note.md");
    });
    act(() => {
      const tab = result.current.active!;
      result.current.updateState(
        tab.id,
        tab.state.update({ changes: { from: 0, insert: "edit " } }).state,
        true,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });
    act(() => {
      result.current.clear();
    });
    rerender({ root: "second" });
    act(() => {
      result.current.newDocument("md");
    });
    await act(async () => {
      save.resolve({ path: "note.md", text: "edit original", revision: "r1" });
      await save.promise;
    });
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.active!.path).toBeNull();
    expect(result.current.active!.state.doc.toString()).toBe("");
  });
});
