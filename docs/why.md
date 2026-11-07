# Why this exists

Three things go wrong with approvals when agents join a team, and each has a source you can check.

## The person who asks can approve

In Switch today, the person who asks can approve their own request. `session_activity/service.py` says "An answer is accepted from anyone who may address the agent", new agents default to owner-only addressing, and the approval record has no requester field. In a small team the owner is usually the person asking. We recorded this, with the person's presses scripted: a refund's approval cards all went to the person who asked for it, and they pressed every one.

## Auto mode moves the risk policy to each vendor

Auto mode has been on by default for new agents since [PR #965](https://github.com/sandbox-quantum/switch/pull/965), and what it means differs by vendor. Under auto, Switch's OpenCode adapter answers every permission with `once` (`opencode-adapter.ts`), so nothing reaches anyone. Switch's own end-to-end test commit `adf8978c` says that with it on, Claude Code ran shell commands "without asking, so no approval card ever appeared". Anthropic [reports](https://www.anthropic.com/engineering/claude-code-auto-mode) a "17% false-negative rate on real overeager actions" for its classifier.

## People who are asked stop reading

The same post says "users accept 93% of them anyway" and describes "approval fatigue, where people stop paying close attention to what they're approving". That figure is about people's own permission prompts. OWASP's [Top 10 for Agentic Applications](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/) lists this as ASI09, Human-Agent Trust Exploitation.
