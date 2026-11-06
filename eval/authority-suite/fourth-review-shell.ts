/**
 * The fourth review's findings in the shell reader and adapters, all fixed since (packages/core/test/fourth-review.test.ts,
 * and policy/tests/fourth-review-shell.yaml for what must stay quiet). fourth-review.ts runs this list with its own. Each
 * check goes through a real hook, as the 25 do, and counts on the fourth review's line.
 */
import { agentCwd } from "../harness/identities.ts";
import type { IsolatedWorld } from "../harness/world.ts";
import type { AuditCheck } from "./audit.ts";
import type { Findings } from "./scene.ts";

const shell = (world: IsolatedWorld, command: string) => world.claudeHook("coder", "Bash", { command });

/** A real POST to Codex's route, whose `command` can be an argv and whose apply_patch reads the markers. */
async function codexHook(world: IsolatedWorld, tool: string, input: Record<string, unknown>): Promise<boolean> {
  const res = await fetch(`http://127.0.0.1:${world.ports.core}/v1/hooks/codex`, {
    method: "POST",
    headers: { authorization: `Bearer ${world.hookTokenOf("coder")}`, "content-type": "application/json" },
    body: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "eval-coder", cwd: agentCwd("coder"), tool_name: tool, tool_input: input }),
  });
  const output = ((await res.json()) as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput;
  return output?.permissionDecision !== "deny";
}

/** Each of these runs with no resistance on the unfixed code, and each of the quiet ones has to stay that way. */
function lines(id: string, title: string, badOutcome: string, held: string[], quiet: string[] = []): AuditCheck {
  return {
    id,
    title,
    badOutcome,
    async run(world: IsolatedWorld, findings: Findings) {
      for (const command of held) findings.bad(`${JSON.stringify(command)} ran with no resistance`, (await shell(world, command)).allow);
      for (const command of quiet) findings.control(`${JSON.stringify(command)} stays quiet`, (await shell(world, command)).allow);
    },
  };
}

export const SHELL_CHECKS: AuditCheck[] = [
  lines(
    "R7a",
    "ANSI-C and locale quoting aren't read as quoting",
    "`$'rm' -rf /` runs, and one reading of the quotes hides a whole command",
    ["$'rm' -rf /", "$'\\x72\\x6d' -rf /", '$"rm" -rf /', "git $'push' --force origin main", "cat $'.env'", "echo x > $'.github/workflows/deploy.yml'", "echo $'\\'' ; rm -rf / ; #'"],
    ["echo $'a\\tb'", 'echo $"hello"'],
  ),
  lines(
    "R7b",
    "A substitution inside `${...}` or `$((...))` isn't read",
    "`echo ${x:-$(rm -rf /)}` runs what's inside it",
    ["echo ${x:-$(rm -rf /)}", 'echo "${x:-$(git push --force origin main)}"', "echo ${x:-`rm -rf /`}", "echo $(( $(git push --force origin main) ))", "echo $((rm -rf /); (ls))"],
    ["echo ${HOME}", 'echo "${FOO:-bar}"', "echo $((1 + 2))", "echo $(( (1 + 2) * 3 ))"],
  ),
  lines(
    "R7c",
    "An unquoted heredoc's body isn't read, and its end can be split",
    "A heredoc runs its substitutions, or ends earlier than it looks, and what follows it runs",
    ["cat <<EOF\n$(git push --force origin main)\nEOF", "cat <<EOF\n`rm -rf /`\nEOF", "cat <<EOF\nx\nEO\\\nF\nrm -rf /\n", "cat <<$(x)\nhello\n$(x)\nrm -rf /\n"],
    ["cat <<EOF\nhello $USER\nEOF", "cat <<'EOF'\n$(rm -rf /)\nEOF"],
  ),
  lines(
    "R7d",
    "What JavaScript calls a space and bash doesn't starts a comment",
    "`ls<NBSP># ; git push --force` runs the push, and the reader sees a comment",
    ["ls # ; git push --force origin main", "ls\u000b# ; rm -rf /", "ls\f# ; rm -rf /"],
    ['echo "café ok"'],
  ),
  {
    id: "R7e",
    title: "Brace expansion and globs make a command word",
    badOutcome: "`{rm,-rf,/}` runs, and a glob reads `.env` past the deny",
    async run(world, findings) {
      for (const command of ["{rm,-rf,/}", "{git,push,--force,origin,main}", "git push origin ma{i,}n", "rm -rf {/,/etc}", "/bin/r? -rf /", "r[m] -rf /", "git p* --force origin main", "cat .en?", "cat .e*"]) {
        findings.bad(`${JSON.stringify(command)} ran with no resistance`, (await shell(world, command)).allow);
      }
      for (const command of ["ls *", "cat *.md", "grep -r foo src/*.ts", "mkdir -p src/{a,b}", "for i in {1..3}; do echo $i; done", "[ -f README.md ]"]) {
        findings.control(`${JSON.stringify(command)} stays quiet`, (await shell(world, command)).allow);
      }
    },
  },
  {
    id: "R7f",
    title: "Grep's own glob reads .env past the deny",
    badOutcome: "A search of `.en*` reads the secrets the rule about `.env` is there for",
    async run(world, findings) {
      for (const glob of [".en*", "**/.en?", "{.env,x}"]) {
        findings.bad(`a Grep of ${glob} ran`, (await world.claudeHook("coder", "Grep", { pattern: "KEY", glob })).allow);
      }
      findings.control("a Grep of *.ts stays quiet", (await world.claudeHook("coder", "Grep", { pattern: "KEY", glob: "*.ts" })).allow);
    },
  },
  lines(
    "R7g",
    "Known runners, spelled another way, still run what they're given",
    "`env -S'rm -rf /'`, `bash +x -c`, `trap` and `git ls-remote --upload-pack` all run commands the reader doesn't see",
    ["env -S'rm -rf /'", "env --split-string='git push --force origin main'", "env - rm -rf /", "bash +x -c 'git push origin main'", "bash --rcfile x -c 'git push origin main'", "trap 'git push --force origin main' EXIT", "echo main | xargs -I{} git push origin {}", "git ls-remote --upload-pack='rm -rf /;:' ."],
    ["env -i ls", "bash -c 'git status'", "trap - EXIT", "git ls-remote origin"],
  ),
  {
    id: "R7h",
    title: "A Codex argv loses the script as one word",
    badOutcome: "`bash -lc <push>` reads as a script called git",
    async run(world, findings) {
      findings.bad("the push in an argv ran", await codexHook(world, "Bash", { command: ["bash", "-lc", "git push --force origin main"] }));
      findings.control("an ordinary argv stays quiet", await codexHook(world, "Bash", { command: ["git", "status"] }));
    },
  },
  lines(
    "R7i",
    "Writing through cp -t, or moving and removing a protected file, isn't touching it",
    "A workflow is written or deleted with no resistance",
    ["cp -t .github/workflows evil.yml", "cp --target-directory=.github/workflows evil.yml", "mv -t .github/workflows evil.yml", "mv .github/workflows/deploy.yml x", "rm .github/workflows/deploy.yml", "cd .github && cd workflows && rm deploy.yml", "cp evil.yml .github"],
    ["cp a.txt b.txt", "mv a.txt b.txt", "rm -rf dist", "rm src/old.ts"],
  ),
  {
    id: "S1",
    title: "Padding around a patch's markers hides a file from it",
    badOutcome: "A patch writes a workflow, and only its first file is read",
    async run(world, findings) {
      const patch = (marker: string) => `*** Begin Patch\n*** Update File: src/a.ts\n@@\n+x\n${marker}*** Update File: .github/workflows/deploy.yml\n@@\n+y\n*** End Patch`;
      findings.bad("a patch with a padded marker wrote a workflow", await codexHook(world, "apply_patch", { command: patch("  ") }));
      findings.control("a patch to src alone stays quiet", await codexHook(world, "apply_patch", { command: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n+x\n*** End Patch" }));
    },
  },
];
