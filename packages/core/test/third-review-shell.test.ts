/**
 * Third review: the inline-code scan. The threat model says a scan of text can be evaded by ingenuity, and those aren't
 * findings. These are the ones that need no ingenuity: a flag the reader doesn't parse, so the code is never scanned at
 * all. The python3, perl and node forms were run against the real interpreters on this machine with something harmless in
 * place of the push, and they do run it. php, ruby and gawk aren't installed here, so those are from their documented
 * flags. Red on purpose, apart from the control block.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hookShell, makeHarness, type Harness } from "./harness.js";

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => h.core.close());

const check = (command: string) => h.core.check(hookShell(command, { agent: { name: "coder", cwd: "/home/x/.switch/agents/m/coder" } }));

describe("T18 a flag the scan doesn't read means the code isn't scanned", () => {
  it.each([
    ["python's -R in a cluster", `python3 -Rc "import os; os.system('git push origin main')"`],
    ["perl's -0 with -e attached", `perl -0e 'system("git push origin main")'`],
    ["perl's -l with a number, then e", `perl -l0e 'system("git push origin main")'`],
    ["node's -C, whose value stops the reader", `node -C dev -e "require('child_process').execSync('git push origin main')"`],
    ["php's -d, whose value stops the reader", `php -d x=1 -r "system('git push origin main');"`],
    ["ruby's -0 with -e attached", `ruby -0e 'system("git push origin main")'`],
    ["gawk's -l, whose value is taken for the program", `gawk -l filefuncs 'BEGIN { system("git push origin main") }'`],
  ])("%s: %s", async (_why, command) => {
    expect((await check(command)).decision).not.toBe("allow");
  });
});

describe("control: the same code with flags the reader knows is held", () => {
  it.each([
    `python3 -c "import os; os.system('git push origin main')"`,
    `python3 -Sc "import os; os.system('git push origin main')"`,
    `perl -e 'system("git push origin main")'`,
    `perl -le 'system("git push origin main")'`,
    `node -e "require('child_process').execSync('git push origin main')"`,
    `php -r "system('git push origin main');"`,
    `ruby -e 'system("git push origin main")'`,
    `awk 'BEGIN { system("git push origin main") }'`,
  ])("%s", async (command) => {
    expect((await check(command)).decision).not.toBe("allow");
  });
});

describe("T19 cheap text that the scan reads and misses (arguably inside the stated limit, so ranked with it)", () => {
  it.each([
    ["node, a bracket instead of a dot", `node -e "process['getBuiltinModule']('child_process').execSync('git push origin main')"`],
    ["python, open under another name", `python3 -c "o=open;print('y',file=o('.github/workflows/x.yml','w'))"`],
    ["ruby, File.new instead of File.open", `ruby -e 'File.new(".github/workflows/x.yml","w").puts("y")'`],
    ["php, a function named in a string", `php -r "array_map('system',['git push origin main']);"`],
  ])("%s: %s", async (_why, command) => {
    expect((await check(command)).decision).not.toBe("allow");
  });
});
