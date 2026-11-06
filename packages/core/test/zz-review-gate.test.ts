/** Independent review: what the hook path lets through. Not committed. */
import type { Action } from "@clearance/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actionId, hookShell, makeHarness, NOW, type Harness } from "./review-harness.js";

const TREE = "/home/x/.switch/agents/m/coder";
let h: Harness;
beforeAll(() => {
  h = makeHarness();
});
afterAll(() => h.core.close());

const shell = (command: string) => hookShell(command, { agent: { name: "coder", cwd: TREE } });
const write = (path: string): Action => ({
  id: actionId(),
  at: new Date(NOW).toISOString(),
  source: "hook",
  vendor: "claude",
  agent: { name: "coder", cwd: TREE },
  kind: "file_write",
  raw: { file_path: path, content: "#!/bin/sh\necho '{}'\n" },
  file: { path },
});

const cases: [string, Action][] = [
  ["control git push --force", shell("git push --force origin main")],
  ["control write .claude/settings.json", write(`${TREE}/.claude/settings.json`)],
  ["write bin/clearance-hook (codex+cursor hook script)", write(`${TREE}/bin/clearance-hook`)],
  ["shell overwrite bin/clearance-hook", shell("printf '#!/bin/sh\\nexit 0\\n' > bin/clearance-hook")],
  ["mv .claude away", shell("mv .claude .claude-old")],
  ["rm -rf .claude", shell("rm -rf .claude")],
  ["rm .opencode dir", shell("rm -r .opencode")],
  ["write opencode.json via shell", shell("echo '{}' > opencode.json")],
  ["write opencode.json via tool", write(`${TREE}/opencode.json`)],
  ["write .mcp.json via tool", write(`${TREE}/.mcp.json`)],
  ["git checkout an old .claude", shell("git checkout HEAD~5 -- .claude")],
  ["git stash -u", shell("git stash -u")],
  ["ln -s over settings", shell("ln -sf /tmp/x .claude")],
  ["sed -i hook config", shell("sed -i 's/block/allow/' .claude/settings.json")],
  ["cd then write", shell("cd .claude && echo '{}' > settings.json")],
  ["make with push target", shell("make release")],
  ["npx wrapper", shell("npx -y some-pkg push")],
  ["git alias push", shell("git -c alias.p=push p --force origin main")],
  ["env -S", shell("env -S 'git push --force origin main'")],
  ["eval", shell("eval 'git push --force origin main'")],
  ["xargs", shell("echo --force | xargs git push origin")],
  ["find -exec", shell("find . -maxdepth 0 -exec git push --force origin main \\;")],
  ["sed e", shell("echo | sed 'e git push --force origin main'")],
  ["bash script written then run", shell("echo 'git push --force origin main' > r.sh && bash r.sh")],
  ["curl gate directly", shell("curl -s -XPOST http://127.0.0.1:7710/acme/refunds -d '{}'")],
  ["curl core API", shell("curl -s http://127.0.0.1:7700/v1/requests")],
  ["curl Switch API", shell("curl -s http://127.0.0.1:8000/agents")],
  ["git config hook path", shell("git config core.hooksPath /tmp")],
  ["git remote set-url", shell("git remote set-url origin /tmp/evil.git")],
];

describe("hook decisions", () => {
  it("prints each decision", async () => {
    const rows: string[] = [];
    for (const [name, action] of cases) {
      const res = await h.core.check(action);
      rows.push(`${res.decision.padEnd(5)} | ${name}`);
    }
    console.log("\n" + rows.join("\n"));
    expect(rows.length).toBe(cases.length);
  });
});
