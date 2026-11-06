/**
 * What the third review's fixes do beyond its own tests in third-review.test.ts: every path check reads the call's real
 * directory, a grant binds whatever on the line might change things, and what's known to be harmless costs no new card.
 * Commands and what the policy does with them are in policy/tests/third-review-shell.yaml.
 */
import { homedir } from "node:os";
import { claudeToActions, codexToActions, cursorToActions, hookRoutes, opencodeToActions } from "@clearance/adapters";
import type { Action } from "@clearance/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseShell } from "../src/classify/shell.js";
import { actionId, hookShell, makeHarness, MINUTE, NOW, type Harness } from "./harness.js";

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => h.core.close());

const TREE = "/home/x/.switch/agents/m/coder";
const ctx = (tree?: string) => ({ agent: "coder", id: actionId(), at: new Date(NOW).toISOString(), ...(tree ? { tree } : {}) });

function approve(response: { request_id?: string | undefined; call_hash?: string | undefined }, agent = "coder"): string {
  const id = response.request_id as string;
  const { requests, grants } = h.core.stores;
  if (requests.get(id)?.state === "HELD") requests.transition(id, "ROUTED");
  requests.transition(id, "APPROVED");
  grants.mint(id, response.call_hash as string, agent, h.clock.scaledMs(10 * MINUTE));
  requests.transition(id, "GRANTED");
  return id;
}
const run = (command: string, overrides: Partial<Action> = {}) => h.core.check(hookShell(command, overrides));
async function grantFor(command: string): Promise<string> {
  const held = await run(command);
  expect(held.decision, `${command} should be held to begin with`).toBe("hold");
  return approve(held);
}

const codex = (command: string, workdir?: string) =>
  codexToActions({ hook_event_name: "PreToolUse", session_id: "s", cwd: TREE, tool_name: "Bash", tool_input: { command, ...(workdir ? { workdir } : {}) } }, ctx())[0] as Action;
const inTree = (command: string): Action => hookShell(command, { agent: { name: "coder", cwd: TREE } });

describe("a workdir outside the agent's directory is a cd there", () => {
  const OTHER = "/home/x/other";

  it.each([
    ["ls"],
    ["pwd"],
    ["git status"],
    ["cat notes.txt"],
    ["echo hi"],
    ["pnpm test"],
    ["python3 -c 'print(1)'"],
  ])("%s is held, whatever it does, as after a cd", async (command) => {
    expect(await h.core.check(codex(`cd ${OTHER} && ${command}`))).toMatchObject({ decision: "hold" });
    expect(await h.core.check(codex(command, OTHER))).toMatchObject({ decision: "hold", class: "unknown_protected" });
  });

  it.each([
    ["a home directory", "~/.ssh"],
    ["somewhere else in a home directory", "~/other"],
    ["somewhere above", "../../../.."],
    ["one level up", ".."],
    ["a credentials directory", "/home/x/.aws"],
  ])("%s isn't allowed", async (_what, workdir) => {
    expect((await h.core.check(codex("ls", workdir))).decision).not.toBe("allow");
  });

  it.each([
    ["a redirect", "echo evil > authorized_keys"],
    ["an append", "echo evil >> authorized_keys"],
    ["tee", "tee authorized_keys < x"],
    ["cp", "cp x authorized_keys"],
    ["mv", "mv x authorized_keys"],
    ["dd", "dd if=x of=authorized_keys"],
    ["sed -i", "sed -i s/a/b/ authorized_keys"],
    ["git's output flag", "git diff --output=authorized_keys"],
    ["find's", "find . -fprint authorized_keys"],
  ])("a write by %s is held, and reads as outside on its own", async (_how, command) => {
    expect((await h.core.check(codex(command, OTHER))).decision).toBe("hold");
    // Inside a directory that's allowed to be read, the write still counts as outside.
    expect((await h.core.check(codex(command, "/tmp"))).decision).toBe("hold");
  });

  it.each([
    ["rm", "rm -rf build"],
    ["rmdir", "rmdir build"],
    ["shred", "shred -u key"],
    ["unlink", "unlink key"],
  ])("%s there reads as a delete of what it names, even in a directory that can be read", async (_how, command) => {
    expect(await h.core.check(codex(command, "/tmp"))).toMatchObject({ decision: "hold", class: "delete" });
  });

  it("reading somewhere that's allowed to be read stays quiet", async () => {
    expect((await h.core.check(codex("cat notes.txt", "/tmp"))).decision).toBe("allow");
    expect((await h.core.check(codex("ls", "/usr/lib"))).decision).toBe("allow");
  });
});

describe("a workdir inside the agent's directory moves what its paths mean", () => {
  it.each([
    ["a redirect", "echo evil > deploy.yml"],
    ["tee", "tee deploy.yml < x"],
    ["cp", "cp x deploy.yml"],
  ])("a write into a protected directory by %s is held", async (_how, command) => {
    expect((await h.core.check(codex(command, ".github/workflows"))).decision).toBe("hold");
    expect((await h.core.check(codex(command, `${TREE}/.github/workflows`))).decision).toBe("hold");
  });

  it.each([
    ["secrets", "cat prod"],
    [".clearance", "cat hook-token"],
    [".claude", "echo x > settings.json"],
    [".claude/x", "cat ../settings.json"],
    // No word on these for the rule about shell text to read: only the path, from where it runs.
    [".claude", "cat > settings.json"],
    [".claude", "cat < .credentials.json"],
  ])("the deny classes read it in %s: %s", async (workdir, command) => {
    expect((await h.core.check(codex(command, workdir))).decision).toBe("deny");
    expect((await h.core.check(codex(`cd ${workdir} && ${command}`))).decision, "and after a cd").toBe("deny");
  });

  it("a safe path is safe where it really is", async () => {
    expect((await h.core.check(codex("echo x > a.ts", "src"))).decision).toBe("allow");
    // This is src/.github/y, which is under src like anything else. The repository's own is one level up.
    expect((await h.core.check(codex("echo x > .github/y", "src"))).decision).toBe("allow");
    expect((await h.core.check(codex("echo x > ../.github/y", "src"))).decision).toBe("hold");
    expect((await h.core.check(codex("echo x > ../../outside", "src"))).decision).toBe("hold");
  });

  it("a climb that stays in the tree isn't outside, and one that leaves is", async () => {
    expect((await h.core.check(codex("cat ../README.md", "src/deep"))).decision).toBe("allow");
    expect((await h.core.check(codex("cat ../../../outside", "src/deep"))).decision).toBe("hold");
    expect((await h.core.check(codex("cat ../outside", "."))).decision).toBe("hold");
  });

  it("an ordinary command there stays quiet", async () => {
    for (const command of ["ls", "git status", "pnpm test", "rm -rf build"]) {
      expect((await h.core.check(codex(command, "src"))).decision, command).toBe("allow");
    }
  });

  it("the agent's own directory, however it's spelled, is no workdir at all", async () => {
    const plain = await h.core.check(inTree("git push origin main"));
    for (const workdir of [TREE, `${TREE}/`, "."]) {
      const held = await h.core.check(codex("git push origin main", workdir));
      expect(held.call_hash, workdir).toBe(plain.call_hash);
    }
    expect(h.chat.cards.every((card) => !card.detail.includes("Runs in"))).toBe(true);
  });
});

describe("OpenCode's workdir gets the same", () => {
  const opencode = (command: string, workdir?: string) =>
    opencodeToActions({ tool: "bash", cwd: TREE, args: { command, ...(workdir ? { workdir } : {}) } }, ctx())[0] as Action;

  it("outside, inside, and at home", async () => {
    expect((await h.core.check(opencode("ls", "/home/x/other"))).decision).toBe("hold");
    expect((await h.core.check(opencode("echo x > deploy.yml", ".github/workflows"))).decision).toBe("hold");
    expect((await h.core.check(opencode("ls", TREE))).decision).toBe("allow");
  });
});

describe("what the person sees", () => {
  it("a workdir outside says where it runs, and what it does", async () => {
    await h.core.check(codex("echo evil > authorized_keys", "/home/x/.config/other"));
    const details = h.chat.cards.map((card) => card.detail).join("\n");
    expect(details).toContain("Runs in: /home/x/.config/other");
    expect(details).toContain("As written: echo evil > authorized_keys");
  });

  it("the outside read names the directory", async () => {
    await h.core.check(codex("ls", "/home/x/other"));
    expect(h.chat.cards[0]?.detail).toContain("Reads outside this agent's own directory: /home/x/other");
  });

  it("a home directory stays one, since that's all that's known about it", async () => {
    await h.core.check(codex("ls", "~/other"));
    expect(h.chat.cards[0]?.detail).toContain("Runs in: ~/other");
  });

  it("a long card gives up its context first, and keeps what the short form leaves out", async () => {
    // Nobody on record as asking, so the flags are long enough that the context has to go.
    const lines: [string, string[]][] = [
      ["for i in 1 2 3; do git push origin main; done", ["As written: for i in 1 2 3; do git push origin main; done", "Repeats: it can run more than once"]],
      ["git push origin $(echo main)", ["As written: git push origin $(echo main)"]],
      ["./setup.sh; git push origin main", ["As written: ./setup.sh; git push origin main"]],
    ];
    for (const [line, expected] of lines) {
      const before = h.chat.cards.length;
      await run(line);
      const card = h.chat.cards[before];
      for (const text of expected) {
        expect(card?.detail.split("Context")[0], `${line} keeps it with the call`).toContain(text);
      }
      expect(card?.detail.length).toBeLessThanOrEqual(960);
    }
  });

  it("a line that only differs after the command stays as context, as it always was", async () => {
    await h.core.check(codex('git push origin main 2>&1; echo "exit=$?"'));
    const detail = h.chat.cards[0]?.detail ?? "";
    expect(detail.split("As written")[0]).toContain("Context");
  });

  it("a command with no workdir has no such line", async () => {
    await h.core.check(codex("git push origin main"));
    expect(h.chat.cards[0]?.detail).not.toContain("Runs in");
  });
});

describe("a grant and a workdir", () => {
  it("binds to where it runs, and can be approved as written", async () => {
    const call = () => codex("git push origin main", "src");
    approve(await h.core.check(call()));
    expect((await h.core.check(codex("git push origin main", "docs"))).decision).toBe("hold");
    expect((await h.core.check(codex("git push origin main"))).decision).toBe("hold");
    expect((await h.core.check(call())).decision).toBe("allow");
  });

  it("everything held on a line outside the tree gets its approval, then it runs once", async () => {
    const call = () => codex("rm -rf etc", "/");
    for (let index = 0; index < 2; index += 1) {
      const held = await h.core.check(call());
      expect(held.decision).toBe("hold");
      approve(held);
    }
    expect((await h.core.check(call())).decision).toBe("allow");
    expect((await h.core.check(call())).decision).toBe("hold");
  });
});

describe("a session that has moved inside its own directory", () => {
  const SUB = `${TREE}/.github/workflows`;

  it("a Write's path is judged from the agent's directory, not where the session is", async () => {
    const write = claudeToActions(
      { hook_event_name: "PreToolUse", cwd: SUB, tool_name: "Write", tool_input: { file_path: `${SUB}/deploy.yml`, content: "evil" } },
      ctx(TREE),
    )[0] as Action;
    expect(write.file?.path).toBe(".github/workflows/deploy.yml");
    expect(write.agent.cwd).toBe(TREE);
    expect((await h.core.check(write)).decision).toBe("hold");
  });

  it("a relative path is from where the session is", async () => {
    const write = claudeToActions(
      { hook_event_name: "PreToolUse", cwd: SUB, tool_name: "Write", tool_input: { file_path: "deploy.yml", content: "evil" } },
      ctx(TREE),
    )[0] as Action;
    expect(write.file?.path).toBe(".github/workflows/deploy.yml");
  });

  it("a shell line is read from where the session is", async () => {
    const bash = (command: string) =>
      claudeToActions({ hook_event_name: "PreToolUse", cwd: SUB, tool_name: "Bash", tool_input: { command } }, ctx(TREE))[0] as Action;
    expect(bash("ls").shell?.workdir).toBe(SUB);
    expect((await h.core.check(bash("echo evil > deploy.yml"))).decision).toBe("hold");
    expect((await h.core.check(bash("ls"))).decision).toBe("allow");
  });

  it("a read of something else in the tree isn't outside just because the session moved", async () => {
    const read = claudeToActions(
      { hook_event_name: "PreToolUse", cwd: `${TREE}/src`, tool_name: "Read", tool_input: { file_path: "../README.md" } },
      ctx(TREE),
    )[0] as Action;
    expect(read.file?.path).toBe("README.md");
    expect((await h.core.check(read)).decision).toBe("allow");
  });

  describe("through the real route, which finds the agent's directory", () => {
    const TOKEN = "hook-token-for-coder-000000000000";
    const coder = `${homedir()}/.switch/agents/demo-host/coder`;
    let app: FastifyInstance;
    beforeEach(async () => {
      app = Fastify();
      await app.register(async (scope) => {
        void hookRoutes(scope, {
          check: (action) => h.core.check(action),
          resolveAgent: (cwd, agentType) => h.core.resolveAgent(cwd, agentType),
          hookTokens: { [TOKEN]: "coder" },
        });
      });
    });
    afterEach(() => app.close());
    const send = async (cwd: string, tool_name: string, tool_input: Record<string, unknown>): Promise<boolean> => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/hooks/claude",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        payload: JSON.stringify({ session_id: "s", hook_event_name: "PreToolUse", cwd, tool_name, tool_input }),
      });
      return (response.json() as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision === "deny";
    };

    it("a write into a protected directory, by either tool, from inside it", async () => {
      const here = `${coder}/.github/workflows`;
      expect(await send(here, "Write", { file_path: `${here}/deploy.yml`, content: "evil" })).toBe(true);
      expect(await send(here, "Bash", { command: "echo evil > deploy.yml" })).toBe(true);
    });

    it("ordinary work from a subdirectory stays quiet", async () => {
      expect(await send(`${coder}/src`, "Bash", { command: "ls" })).toBe(false);
      expect(await send(`${coder}/src`, "Write", { file_path: `${coder}/src/a.ts`, content: "x" })).toBe(false);
      expect(await send(coder, "Bash", { command: "ls" })).toBe(false);
    });
  });
});

describe("Cursor", () => {
  const cursor = (cwd: string, command = "rm -rf ../build") =>
    cursorToActions({ hook_event_name: "beforeShellExecution", conversation_id: "c", command, cwd, workspace_roots: ["/w"] }, { agent: "reviewer", id: actionId(), at: new Date(NOW).toISOString() })[0] as Action;

  it("the workspace root is the agent's directory, and cwd is where the command runs", () => {
    expect(cursor("/w").agent.cwd).toBe("/w");
    expect(cursor("/w").shell?.workdir).toBeUndefined();
    expect(cursor("/w/").shell?.workdir).toBeUndefined();
    expect(cursor("/w/src").shell?.workdir).toBe("/w/src");
  });

  it("with no roots, cwd is both", () => {
    const action = cursorToActions({ hook_event_name: "beforeShellExecution", command: "ls", cwd: "/w/src" }, ctx())[0] as Action;
    expect(action.agent.cwd).toBe("/w/src");
    expect(action.shell?.workdir).toBeUndefined();
  });

  it("gets the path checks too", async () => {
    expect((await h.core.check(cursor("/w/.github/workflows", "echo evil > deploy.yml"))).decision).toBe("hold");
    expect((await h.core.check(cursor("/w/src", "ls"))).decision).toBe("allow");
  });
});

describe("the parser follows cd", () => {
  const directories = (line: string) => parseShell(line).commands.map((command) => command.directory);

  it.each([
    ["ls", [""]],
    ["cd src; ls", ["", "src"]],
    ["cd src && cd deep && ls", ["", "src", "src/deep"]],
    ["cd src; cd ..; ls", ["", "src", ""]],
    ["cd .; ls", ["", ""]],
    ["cd -P src; ls", ["", "src"]],
    ["cd -- src; ls", ["", "src"]],
    ["cd /abs; ls", ["", "/abs"]],
    ["cd /abs; cd sub; ls", ["", "/abs", "/abs/sub"]],
    ["cd ~/x; ls", ["", "~/x"]],
    ["cd; ls", ["", "~"]],
    ["cd -; ls", ["", null]],
    ['cd "$X"; ls', ["", null]],
    ['cd "$X"; cd sub; ls', ["", null, null]],
    ['cd "$X"; cd /abs; ls', ["", null, "/abs"]],
    ["pushd src; ls", ["", "src"]],
    ["pushd src; popd; ls", ["", "src", null]],
    ["command cd src; ls", ["", "src"]],
  ])("%s", (line, expected) => {
    expect(directories(line)).toEqual(expected);
  });

  it("a subshell or a substitution keeps its cd to itself", () => {
    expect(parseShell("(cd src; ls); ls").commands.map((command) => [command.canonical, command.directory])).toEqual([
      ["cd src", ""],
      ["ls", "src"],
      ["ls", ""],
    ]);
    expect(parseShell("echo $(cd src; pwd); ls").commands.at(-1)?.directory).toBe("");
    expect(parseShell("cat <(cd src; ls); ls").commands.at(-1)?.directory).toBe("");
  });

  it("a shell string starts where it's run from, and keeps its cd to itself", () => {
    const { commands } = parseShell("cd src; bash -c 'cd deep; ls'; ls");
    expect(commands.map((command) => [command.canonical, command.directory])).toEqual([
      ["cd src", ""],
      ["cd deep", "src"],
      ["ls", "src/deep"],
      ["ls", "src"],
    ]);
  });

  it("a wrapper's directory is for its one command", () => {
    for (const line of ["env -C sub ls; ls", "env --chdir=sub ls; ls", "sudo -D sub ls; ls", "unshare -w sub ls; ls", "unshare --wd=sub ls; ls"]) {
      expect(parseShell(line).commands.map((command) => command.directory), line).toEqual(["sub", ""]);
    }
    expect(parseShell("env -C sub bash -c 'ls'; ls").commands.map((command) => command.directory)).toEqual(["sub", ""]);
  });
});

describe("what an earlier command can do to a grant", () => {
  const PUSH = "git push origin main";

  it.each([
    ["printf -v", "printf -v PATH %s ./evil"],
    ["printf -vPATH", "printf -vPATH %s ./evil"],
    ["read", "read PATH <<< ./evil"],
    ["mapfile", "mapfile -t X < y"],
    ["getopts", "getopts a OPTARG"],
    ["a script of its own", "./setup.sh"],
    ["a command this has never heard of", "frobnicate"],
    ["make", "make prepare"],
    ["git checkout", "git checkout other"],
    ["git commit", "git commit -m x"],
    ["git fetch", "git fetch origin"],
    ["git remote", "git remote set-url origin evil"],
    ["a harmless command that writes", "echo x > file"],
    ["another", "cat a > b"],
    ["only a redirect", "> file"],
    ["a harmless command with a harmful one inside", "echo $(git remote set-url origin evil)"],
  ])("%s isn't covered", async (_what, before) => {
    await grantFor(PUSH);
    const line = `${before}; ${PUSH}`;
    const held = await run(line);
    expect(held.decision, line).toBe("hold");
    expect(held.class).toBe("merge");
    approve(held);
    expect((await run(line)).decision, "and approving it as written works").toBe("allow");
    expect((await run(PUSH)).decision, "the plain grant is still there").toBe("allow");
  });

  it.each([
    ["echo", "echo pushing"],
    ["printf", "printf '%s\\n' pushing"],
    ["ls", "ls -la"],
    ["cat", "cat README.md"],
    ["grep", "grep -n x README.md"],
    ["pwd", "pwd"],
    ["true", "true"],
    ["a test", "test -f x"],
    ["sleep", "sleep 1"],
    ["wc", "wc -l README.md"],
    ["git status", "git status"],
    ["git log", "git log --oneline -3"],
    ["git diff", "git diff --stat"],
    ["git rev-parse", "git rev-parse HEAD"],
    ["git with its own directory", "git -C . status"],
    ["a pipe of harmless things", "git log --oneline | head -5"],
  ])("after %s, the plain grant still covers it: nothing changed", async (_what, before) => {
    await grantFor(PUSH);
    expect((await run(`${before}; ${PUSH}`)).decision).toBe("allow");
  });

  it("an if on something harmless doesn't count, and one on something else does", async () => {
    await grantFor(PUSH);
    expect((await run(`if true; then ${PUSH}; fi`)).decision).toBe("allow");
    await grantFor(PUSH);
    expect((await run(`if ./check.sh; then ${PUSH}; fi`)).decision).toBe("hold");
  });

  it("the same command twice is still called what it is, though the first is setup for the second", async () => {
    await grantFor(PUSH);
    const held = await run(`${PUSH} && ${PUSH}`);
    expect(held.decision).toBe("hold");
    expect(h.chat.cards.at(-1)?.detail).toContain("Run 2 of this same command on this line");
  });
});

describe("a loop the parser can't see", () => {
  const PUSH = "git push origin main";

  it.each([
    ["time", `time for i in 1 2 3; do ${PUSH}; done`],
    ["time -p", `time -p for i in 1 2 3; do ${PUSH}; done`],
    ["time --", `time -- for i in 1 2 3; do ${PUSH}; done`],
    ["not, then time", `! time for i in 1 2 3; do ${PUSH}; done`],
    ["time, then not", `time ! for i in 1 2 3; do ${PUSH}; done`],
    ["an until", `time until false; do ${PUSH}; done`],
    ["a wrapper, which hides the opener", `nohup for i in 1 2 3; do ${PUSH}; done`],
    ["a word in front of it", `frob for i in 1 2 3; do ${PUSH}; done`],
    ["an assignment in front of it", `X=1 for i in 1 2 3; do ${PUSH}; done`],
    ["a brace loop's closer", `for i in 1 2; { ${PUSH}; }`],
  ])("%s isn't covered by a grant for one run", async (_what, line) => {
    await grantFor(PUSH);
    expect((await run(line)).decision, line).toBe("hold");
    expect((await run(PUSH)).decision, "and the plain grant is untouched").toBe("allow");
  });

  it("knows the body repeats, behind time", () => {
    const body = parseShell(`time for i in 1 2; do ${PUSH}; done; ls`).commands;
    expect(body.map((command) => [command.canonical, command.repeats])).toEqual([
      [PUSH, true],
      ["ls", false],
    ]);
  });

  it("time on one command is still a wrapper a grant binds to", async () => {
    await grantFor(PUSH);
    const held = await run(`time ${PUSH}`);
    expect(held.decision).toBe("hold");
    expect(h.core.stores.requests.require(held.request_id as string).call.args).toEqual({ command: `time ${PUSH}` });
  });

  it("a quoted done is a command, and closes nothing", () => {
    const parsed = parseShell(`for i in 1 2; do "done"; ${PUSH}; done`);
    expect(parsed.ok).toBe(true);
    expect(parsed.commands.at(-1)?.repeats).toBe(true);
  });

  it("every done has to close something", () => {
    expect(parseShell("for i in 1; do ls; done; done").ok).toBe(false);
    expect(parseShell("done").ok).toBe(false);
    expect(parseShell("(done)").ok).toBe(false);
    expect(parseShell("bash -c 'done'").ok).toBe(false);
  });
});

describe("a patch with several sections for one file", () => {
  const of = (patch: string) =>
    codexToActions({ hook_event_name: "PreToolUse", session_id: "s", cwd: "/w", tool_name: "apply_patch", tool_input: { command: patch } }, ctx()) as Action[];

  it("shows and binds all of them", () => {
    const patch = "*** Begin Patch\n*** Update File: a\n@@\n+first\n*** Update File: b\n@@\n+other\n*** Update File: a\n@@\n+second\n*** End Patch";
    const [a, b] = of(patch) as [Action, Action];
    expect(a.file?.path).toBe("a");
    expect(a.written?.content).toBe("first\nsecond");
    expect(a.written?.replaces).toContain("+first");
    expect(a.written?.replaces).toContain("+second");
    expect(a.written?.replaces).not.toContain("+other");
    expect(b.written?.content).toBe("other");
  });

  it("a section that only removes still counts", () => {
    const patch = "*** Begin Patch\n*** Update File: a\n@@\n-gone\n*** Update File: a\n@@\n+kept\n*** End Patch";
    const [a] = of(patch) as [Action];
    expect(a.written?.content).toBe("kept");
    expect(a.written?.replaces).toContain("-gone");
    const other = "*** Begin Patch\n*** Update File: a\n@@\n-other\n*** Update File: a\n@@\n+kept\n*** End Patch";
    expect((of(other)[0] as Action).written?.replaces).not.toBe(a.written?.replaces);
  });
});
