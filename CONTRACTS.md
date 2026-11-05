# Clearance contracts (frozen — change only with both people's agreement)

## Contract 1: repo layout and owners
| Path | Owner |
| --- | --- |
| clearance/ | A |
| hook/clearance_hook.py | A |
| policy/policy.yaml | A schema, B demo values |
| policy/org.yaml | B |
| demo/acme_ops/ | B |
| demo/agents/{support-bot,refunds-bot,deploy-bot}/ | B |
| demo/template/acme.template.yaml | B |
| study/ | B |
| tests/ | both (own code) |
| README.md, docs/, blog.md | B (A reviews) |
| CLAUDE.md, CONTRACTS.md | A |

## Contract 2: hook ↔ Clearance server (A owns)
Server: http://127.0.0.1:8787

POST /v1/requests
  body: {"agent": "refunds-bot", "tool_name": "mcp__acme__issue_refund", "tool_input": {...}, "session_id": "...", "cwd": "..."}
  200:  {"request_id": "CLR-12", "decision": "allow" | "deny" | "hold", "reason": "..."}

GET /v1/requests/{id}/wait?timeout=25
  200:  {"decision": "allow" | "deny" | "pending", "reason": "...", "decided_by": "Arjun"}

GET  /v1/health   -> {"ok": true}
GET  /v1/ledger   -> last 100 ledger lines
POST /v1/drills   -> sends one drill now

The hook polls `wait` until allow/deny, max 10 minutes, then prints Claude Code PreToolUse JSON:
{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"|"deny", "permissionDecisionReason": "..."}}
Server unreachable: deny risky tools, allow read-only ones (fail closed).

## Contract 3: fake company tools (B owns)
MCP server name `acme` → Claude Code tool names `mcp__acme__<tool>`.
| Tool | Arguments | Changes something? |
| --- | --- | --- |
| lookup_order | order_id: str | no |
| issue_refund | order_id: str, customer_id: str, amount_inr: int, reason: str | yes, not undoable |
| send_customer_email | to: str, subject: str, body: str | yes, not undoable |
| deploy | service: str, version: str, environment: "staging" or "production" | yes, can roll back |
| delete_customer_data | customer_id: str | yes, not undoable |

acme.db (SQLite) tables:
- orders(order_id, customer_id, customer_name, amount_inr, status, created_at)
- customers(customer_id, name, email, tier)
- actions(id, tool, args_json, agent, created_at)
Every mutating tool writes one `actions` row. Must contain order A-1042, ₹4,000, customer C-221 Neha Sharma, tier standard. Clearance reads acme.db READ-ONLY for evidence.

## Contract 4: chat commands (A owns)
| Command | Who may | Effect |
| --- | --- | --- |
| approve CLR-12 | the routed approver | allows the held call |
| deny CLR-12 <reason> | the routed approver | denies; reason goes back to the agent |
| promote CLR-P3 | policy owner | signs an earned-autonomy proposal |
| incident CLR-12 | policy owner | marks a past decision bad; agent demoted |
| !clearance stats | anyone | approver stats |
| !clearance pending | anyone | open requests the asker may answer |

## Contract 5: the card (A owns)
🔒 CLR-12 · HIGH RISK · refund_large
refunds-bot wants to: issue_refund
  Amount:     ₹40,000   (order A-1042 was ₹4,000 → 10× the order)
  Customer:   C-221 · Neha Sharma · tier: standard
  Undoable:   NO
  Asked by:   Riya (cannot approve: requester)
  Agent said: "a small goodwill refund"   ⚠ differs from the call
Approver: @arjun (finance lead) · escalates to @kabir in 90 s
Reply: approve CLR-12 | deny CLR-12 <reason>

## Contract 6: ledger line (A owns)
One JSON object per line in data/ledger.jsonl, mirrored to the #clearance room document "Clearance ledger":
{ts, request_id, agent, tool, action_class, risk, args, requester, approver, decision, decided_by, seconds_to_decide, drill (bool), flags (list, e.g. ["rubber_stamp"])}

## Demo cast and rooms
Users: riya (support lead, the requester), arjun (finance lead + policy owner), kabir (engineering lead).
Rooms: #support (support-bot), #finance (refunds-bot), #eng (deploy-bot), #clearance (approvals inbox + ledger). Clearance is in all four.

## Policy classes (demo values)
| Class | Matches | Risk | Approver | Autonomy eligible |
| --- | --- | --- | --- | --- |
| read_only | lookup_order | none | none, always allowed | — |
| refund_small | issue_refund, amount_inr <= 2000 | low | support-lead | yes |
| refund_large | issue_refund, amount_inr > 2000 | high | finance-lead | no |
| customer_email | send_customer_email | medium | support-lead | yes |
| deploy_staging | deploy, staging | low | none, allowed and logged | — |
| deploy_production | deploy, production | high | eng-lead | no |
| delete_data | delete_customer_data | critical | finance-lead AND eng-lead (2 approvals) | no |
Rubber-stamp minimum seconds: low 0, medium 3, high 6, critical 10. Escalation after 90 s. Autonomy proposal after 5 clean approvals.
