/**
 * What a write would do has to reach core, because an approval is bound to it. Everything that changes the result counts,
 * so each tool's fields are checked by name, and the agent's own description is the one thing left out, since it's only a
 * claim and an agent rewords it on retry.
 */
import { describe, expect, it } from "vitest";
import type { Action } from "@clearance/contracts";
import { claudeToActions } from "../src/claude.js";
import { codexToActions } from "../src/codex.js";
import { opencodeToActions } from "../src/opencode.js";

const ctx = { agent: "coder", id: "a1", at: "2026-11-04T08:30:00.000Z" };
const claude = (tool_name: string, tool_input: Record<string, unknown>) =>
  claudeToActions({ hook_event_name: "PreToolUse", cwd: "/w", tool_name, tool_input }, ctx);
const codex = (tool_name: string, tool_input: Record<string, unknown>) =>
  codexToActions({ hook_event_name: "PreToolUse", cwd: "/w", tool_name, tool_input }, ctx);
const opencode = (tool: string, args: Record<string, unknown>) => opencodeToActions({ tool, cwd: "/w", args }, ctx);
const only = (actions: Action[]): Action => {
  expect(actions).toHaveLength(1);
  return actions[0] as Action;
};

describe("Claude", () => {
  it("Write is its content", () => {
    expect(only(claude("Write", { file_path: "a", content: "x" })).written).toEqual({ content: "x" });
  });

  it("an empty file is still a write of something", () => {
    expect(only(claude("Write", { file_path: "a", content: "" })).written).toEqual({ content: "" });
  });

  it("Edit is its new text, and what it replaces", () => {
    const { written } = only(claude("Edit", { file_path: "a", old_string: "o", new_string: "n", replace_all: true }));
    expect(written?.content).toBe("n");
    expect(JSON.parse(written?.replaces as string)).toEqual({ old_string: "o", replace_all: true });
  });

  it("MultiEdit is all of its edits", () => {
    const edits = [
      { old_string: "a", new_string: "b" },
      { old_string: "c", new_string: "d" },
    ];
    const { written } = only(claude("MultiEdit", { file_path: "a", edits }));
    expect(written?.content).toBe("b\nd");
    expect(JSON.parse(written?.replaces as string)).toEqual(edits);
  });

  it("NotebookEdit is its new source, and which cell", () => {
    const { written, file } = only(claude("NotebookEdit", { notebook_path: "n.ipynb", new_source: "s", cell_id: "c", edit_mode: "replace" }));
    expect(file).toEqual({ path: "n.ipynb" });
    expect(written?.content).toBe("s");
    expect(JSON.parse(written?.replaces as string)).toEqual({ cell_id: "c", edit_mode: "replace" });
  });

  it("deleting a cell has no new text, and what it deletes still counts", () => {
    const { written } = only(claude("NotebookEdit", { notebook_path: "n.ipynb", cell_id: "c", edit_mode: "delete" }));
    expect(written?.content).toBeUndefined();
    expect(JSON.parse(written?.replaces as string)).toEqual({ cell_id: "c", edit_mode: "delete" });
  });

  it("a field added later still counts", () => {
    const { written } = only(claude("Write", { file_path: "a", content: "x", mode: "append" }));
    expect(JSON.parse(written?.replaces as string)).toEqual({ mode: "append" });
  });

  it("the description doesn't", () => {
    expect(only(claude("Write", { file_path: "a", content: "x", description: "first try" })).written).toEqual({ content: "x" });
  });

  it("a read has nothing written", () => {
    expect(only(claude("Read", { file_path: "a" })).written).toBeUndefined();
  });
});

describe("Codex", () => {
  it("Write and Edit are as for Claude", () => {
    expect(only(codex("Write", { file_path: "a", content: "x" })).written).toEqual({ content: "x" });
    expect(only(codex("Edit", { file_path: "a", old_string: "o", new_string: "n" })).written?.content).toBe("n");
  });

  it("apply_patch gives each file its own part of the patch", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: new.txt",
      "+hello",
      "+there",
      "*** Update File: old.txt",
      "@@",
      "-gone",
      "+kept",
      "*** Delete File: dead.txt",
      "*** End Patch",
    ].join("\n");
    const [added, updated, deleted] = codex("apply_patch", { command: patch }) as [Action, Action, Action];
    expect(added.file?.path).toBe("new.txt");
    expect(added.written?.content).toBe("hello\nthere");
    expect(added.written?.replaces).toContain("*** Add File: new.txt");
    expect(added.written?.replaces).not.toContain("old.txt");
    expect(updated.written?.content).toBe("kept");
    expect(updated.written?.replaces).toContain("-gone");
    expect(deleted.written?.content).toBeUndefined();
    expect(deleted.written?.replaces).toContain("*** Delete File: dead.txt");
    expect(deleted.written?.replaces).not.toContain("End Patch");
  });

  it("a rename binds both paths to the same change", () => {
    const patch = "*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n@@\n-x\n+y\n*** End Patch";
    const [from, to] = codex("apply_patch", { command: patch }) as [Action, Action];
    expect(from.file?.path).toBe("a.txt");
    expect(to.file?.path).toBe("b.txt");
    expect(from.written).toEqual(to.written);
    expect(from.written?.content).toBe("y");
  });

  it("passes the tool's own directory through", () => {
    expect(only(codex("Bash", { command: "ls", workdir: "src" })).shell).toEqual({ command: "ls", workdir: "src" });
    expect(only(codex("Bash", { command: "ls" })).shell).toEqual({ command: "ls" });
  });
});

describe("OpenCode", () => {
  it("write is its content", () => {
    expect(only(opencode("write", { filePath: "a", content: "x" })).written).toEqual({ content: "x" });
  });

  it("edit is its new text, and what it replaces", () => {
    const { written } = only(opencode("edit", { filePath: "a", oldString: "o", newString: "n", replaceAll: true }));
    expect(written?.content).toBe("n");
    expect(JSON.parse(written?.replaces as string)).toEqual({ oldString: "o", replaceAll: true });
  });

  it("multiedit is all of its edits", () => {
    const edits = [{ oldString: "a", newString: "b" }];
    const { written } = only(opencode("multiedit", { filePath: "a", edits }));
    expect(written?.content).toBe("b");
    expect(JSON.parse(written?.replaces as string)).toEqual(edits);
  });

  it("apply_patch reads patchText", () => {
    const patch = "*** Begin Patch\n*** Add File: a\n+x\n*** End Patch";
    expect(only(opencode("apply_patch", { patchText: patch })).written?.content).toBe("x");
  });

  it("passes the tool's own directory through", () => {
    expect(only(opencode("bash", { command: "ls", workdir: "src", description: "x" })).shell).toEqual({ command: "ls", workdir: "src" });
  });
});
