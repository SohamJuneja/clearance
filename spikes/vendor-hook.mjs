#!/usr/bin/env node
// Spike S5: a command hook for Codex (PreToolUse, PermissionRequest) and Cursor
// (beforeShellExecution). Reads the vendor's JSON on stdin, asks the echo server,
// and prints the decision in that vendor's shape. Fails closed: if the server cannot
// be reached, it denies, and it never waits long, since Codex hook failures fail open.
//
//   node spikes/vendor-hook.mjs codex|cursor [url]
const vendor = process.argv[2] ?? 'codex';
const url = process.argv[3] ?? process.env.SPIKE_HOOK_URL ?? 'http://127.0.0.1:7790/hook/deny-push';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw || '{}');

function deny(reason) {
  if (vendor === 'cursor') {
    console.log(JSON.stringify({ permission: 'deny', user_message: reason, agent_message: reason }));
  } else if (input.hook_event_name === 'PermissionRequest') {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'deny', message: reason },
        },
      })
    );
  } else {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      })
    );
  }
}

let answer;
try {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ spike_vendor: vendor, ...input }),
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  answer = await res.json();
} catch (error) {
  deny(`Clearance is unreachable, so this is blocked (${String(error)}).`);
  process.exit(0);
}
const out = answer.hookSpecificOutput;
if (out?.permissionDecision === 'deny') deny(out.permissionDecisionReason);
else if (vendor === 'cursor') console.log(JSON.stringify({ permission: 'allow' }));
