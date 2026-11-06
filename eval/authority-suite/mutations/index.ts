/**
 * Mutation checks for E1: take one control away and see whether its case notices. A case that still reads "prevented"
 * with its control gone isn't testing that control. The audit found exactly that for cases 2 and 9.
 *
 * A policy or team mutation rewrites the isolated world's own copy of the file. A code mutation runs a changed copy of
 * core under `.tmp/`. Nothing under packages/ or policy/ is ever touched, and a find string that no longer matches is an
 * error, so a mutation can't quietly stop mutating anything.
 */
export interface Edit {
  find: string;
  replace: string;
}

export interface SourceEdit extends Edit {
  /** Relative to the repo: packages/core/src/... or packages/adapters/src/... */
  file: string;
}

export interface Mutation {
  id: string;
  /** The case number or audit check. */
  target: number | string;
  /** Run only this way in, when the others have nothing to do with the control. */
  variant?: string;
  removes: string;
  /**
   * `flips`: the bad outcome really happens without this control.
   * `still holds`: it doesn't, because something else also stops it. `because` says what.
   */
  expect: "flips" | "still holds";
  because?: string;
  policy?: Edit[];
  source?: SourceEdit[];
}

const FINANCE_APPROVER = "the requester is a finance approver who named the agent";
const ROUTER = "packages/core/src/router/router.ts";
const ANSWERS = "packages/core/src/answers/store.ts";
const CORE = "packages/core/src/core.ts";
const REQUESTERS = "packages/core/src/router/requesters.ts";
const SHELL = "packages/core/src/classify/shell.ts";
const FETCH = "packages/core/src/classify/fetch.ts";
const HOOK_ROUTES = "packages/adapters/src/hook-routes.ts";

const NO_COUNTED_REFUSAL: SourceEdit = {
  file: ROUTER,
  find: `if (ctx.counted.includes(id)) reasons.push("counted");`,
  replace: "",
};
const NO_DISTINCT_COUNT: SourceEdit = {
  file: ANSWERS,
  find: `WHERE request_id = ? AND eligible = 1 AND decision = 'approve' AND user_id IS NOT NULL
         GROUP BY user_id ORDER BY first`,
  replace: `WHERE request_id = ? AND eligible = 1 AND decision = 'approve' AND user_id IS NOT NULL
         GROUP BY id ORDER BY first`,
};

export const MUTATIONS: Mutation[] = [
  {
    id: "no-requester-exclusion",
    target: 1,
    variant: FINANCE_APPROVER,
    removes: "defaults.exclude_requester",
    expect: "flips",
    policy: [{ find: "exclude_requester: true", replace: "exclude_requester: false" }],
  },
  {
    id: "no-requester-exclusion-role",
    target: 1,
    variant: "the requester uses a role, in a room the agent is known to be in",
    removes: "defaults.exclude_requester, on the no-@ path",
    expect: "flips",
    policy: [{ find: "exclude_requester: true", replace: "exclude_requester: false" }],
  },
  {
    id: "no-voice-attribution",
    target: 1,
    variant: "the requester uses a role, in a room the agent is known to be in",
    removes: "counting people who speak in the agent's rooms as requesters",
    // Sam isn't on record then, so the case's first check names exactly what went.
    expect: "flips",
    source: [
      {
        file: REQUESTERS,
        find: "if (userId) this.recordVoice(evt, userId, named.some((name) => !this.directory.knowsMention(name)));",
        replace: "",
      },
    ],
  },
  {
    id: "no-owner-exclusion",
    target: 2,
    removes: "defaults.exclude_agent_owner_from",
    expect: "flips",
    policy: [
      { find: "exclude_agent_owner_from: high", replace: "exclude_agent_owner_from: critical" },
    ],
  },
  {
    id: "anyone-in-eng-approves-refunds",
    target: 3,
    removes: "the refund class's approver list",
    expect: "flips",
    policy: [
      {
        find: "any_of: [ { role: finance-approver }, { group: finance } ]",
        replace: "any_of: [ { role: finance-approver }, { group: finance }, { group: eng } ]",
      },
    ],
  },
  {
    id: "long-request-ttl",
    target: 8,
    removes: "defaults.request_ttl",
    expect: "flips",
    policy: [{ find: "request_ttl: 25m", replace: "request_ttl: 24h" }],
  },
  {
    id: "no-counted-refusal",
    target: 9,
    removes: "the `counted` exclusion",
    expect: "still holds",
    because: "countedApprovers counts distinct people, so a second answer from Sam adds nothing",
    source: [NO_COUNTED_REFUSAL],
  },
  {
    id: "no-counted-refusal-no-distinct-count",
    target: 9,
    removes: "the `counted` exclusion and the distinct count",
    expect: "flips",
    source: [NO_COUNTED_REFUSAL, NO_DISTINCT_COUNT],
  },
  {
    id: "two-accounts-count-twice",
    target: 10,
    removes: "the `counted` exclusion and the distinct count",
    expect: "flips",
    source: [NO_COUNTED_REFUSAL, NO_DISTINCT_COUNT],
  },
  {
    id: "chains-lose-the-requester",
    target: 12,
    removes: "passing requesters along an agent-to-agent chain",
    expect: "flips",
    source: [
      {
        file: REQUESTERS,
        find: "for (const userId of this.requestersOf(senderAgent)) this.record(agent, evt, userId, senderAgent);",
        replace: "",
      },
    ],
  },
  {
    id: "no-aggregate-rule",
    target: 13,
    removes: "the refund class's 24 h aggregate rules",
    expect: "flips",
    policy: [
      {
        find: "      - { sum: amount, by: customer, window: 24h, over: 10000, then: hold, why: 'refunds to one customer over ₹10,000 in 24 h' }\n",
        replace: "",
      },
      {
        find: "      - { sum: amount, by: destination, window: 24h, over: 10000, then: hold, why: 'refunds to one destination over ₹10,000 in 24 h' }\n",
        replace: "",
      },
      { find: "    aggregate:", replace: "    aggregate: [] #" },
    ],
  },
  {
    id: "hook-config-not-protected",
    target: 15,
    removes: "protected_config's rules for the hook files",
    expect: "flips",
    policy: [
      { find: "      - { file_write: '(^|/)\\.(claude|codex|opencode|cursor)/' }\n", replace: "" },
      {
        find: "      - { shell: '(^|[\\s/\"''=>])\\.(claude|codex|opencode|cursor)/' }\n",
        replace: "",
      },
    ],
  },
  {
    id: "update-agent-detail-not-protected",
    target: 22,
    // Two layers now: the deny rule, and a safe list that names Switch's tools rather than allowing them all. Either alone holds it.
    removes: "protected_config's rule for update_agent_detail, and the named list of Switch's safe tools",
    expect: "flips",
    policy: [
      { find: "      - { mcp: 'update_agent_detail' }\n", replace: "" },
      { find: "safe:                    # pass silently, no card (\"quiet on safe work\")\n", replace: "safe:\n  - { mcp: 'switch/*' }\n" },
    ],
  },
  {
    id: "f1-unknown-requester-needs-one",
    target: "F1",
    removes: "two people when core can't name who asked",
    expect: "flips",
    source: [
      {
        file: CORE,
        find: "quorumRequired: requesterIds.length === 0 || unlinked || lost || alias || authorLookupFailed ? unknownQuorum : asked,",
        replace: "quorumRequired: unlinked || lost || alias || authorLookupFailed ? unknownQuorum : asked,",
      },
    ],
  },
  {
    id: "f2-git-settings-unchecked",
    target: "F2",
    removes: "the check on `git -c` settings",
    expect: "flips",
    source: [
      {
        file: SHELL,
        find: "if (!GIT_HARMLESS_SETTINGS.test(key)) return `git -c ${key}, which can change what git runs`;",
        replace: "",
      },
    ],
  },
  {
    id: "f3-xargs-unchecked",
    target: "F3",
    removes: "the check on what `xargs` and `find -exec` destroy",
    expect: "flips",
    source: [
      {
        file: SHELL,
        find: `if (DESTROYS_ITS_TARGET.has(name) && (carried.by === "xargs" || words.slice(1).some(has))) {`,
        replace: "if (false) {",
      },
    ],
  },
  {
    id: "f4-decoy-counts-as-gate",
    target: "F4",
    removes: "reading a curl's real host instead of its text",
    expect: "flips",
    source: [
      {
        file: FETCH,
        find: "if (gateHosts.length === 0 || wrappers.some((word) => ENV_REROUTES.test(word))) return false;",
        replace: `if (words.join(" ").includes(":7710")) return true;
  if (gateHosts.length === 0 || wrappers.some((word) => ENV_REROUTES.test(word))) return false;`,
      },
    ],
  },
  {
    id: "f5-claim-decides-the-agent",
    target: "F5",
    removes: "the token deciding which agent is calling",
    expect: "flips",
    source: [
      {
        file: HOOK_ROUTES,
        find: `const refused = claimsRefused(adapter, payload, agent);
    if (refused) return deny(refused);
    const actions = adapter.toActions(payload, {
      agent,`,
        replace: `const actions = adapter.toActions(payload, {
      agent: adapter.agentType?.(payload) ?? agent,`,
      },
    ],
  },
];

/** Applies edits in order. A find string that isn't there means the code moved and this check needs a look. */
export function applyEdits(text: string, edits: Edit[], where: string): string {
  let result = text;
  for (const edit of edits) {
    if (!result.includes(edit.find)) {
      throw new Error(`${where} no longer contains: ${edit.find.slice(0, 80)}`);
    }
    result = result.replace(edit.find, () => edit.replace);
  }
  return result;
}
