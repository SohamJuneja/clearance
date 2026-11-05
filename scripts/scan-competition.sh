#!/usr/bin/env bash
# Watches the field, per PLAN 16.5. Read only: `gh search repos` and `gh search code`, nothing else.
#
#   scripts/scan-competition.sh                 search every term, then read fragments of what surfaced
#   SCAN_READ_LIMIT=10 scripts/...              make at most 10 reading queries (default 60)
#
# Writes to eval/out/competition/<stamp>/ (gitignored): one JSON file per query, status.tsv with what
# each query did, leads.json with the repos worth reading, and fragments/ with what they say. Prints a
# summary.
#
# "Flip the Switch" is also an English idiom, so each term runs twice: narrowed by the word "hackathon",
# which is precise, and bare as PLAN 16.5 wrote it, which finds more and needs filtering. Code search
# ignores phrases, so its rows only count when the repo names the hackathon elsewhere or in the fragment.
#
# Reading a repo means one code search per word that surfaced it, because code search here takes neither
# OR nor a phrase of alternatives, and many repos aren't in its index at all. So a zero means "search
# showed nothing", never "the repo doesn't do this".
#
# A query that fails or hits a rate limit is recorded and retried once after the limit resets. The
# script exits 1 if any query still failed, because a quiet gap would read as "nobody built this".
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$ROOT/eval/out/competition/$STAMP"
READ_LIMIT="${SCAN_READ_LIMIT:-60}"
# GitHub allows 30 repo searches and 10 code searches a minute. Pacing under that keeps the retry spare.
REPO_PACE_S=3
CODE_PACE_S=7
RETRY_WAIT_S=70

HACKATHON="Flip the Switch"
# PLAN 16.5's five terms, then the phrasings of what we pitch as ours (PLAN 16.3).
TERMS=(
  "approval inbox"
  "rubber"
  "drill"
  "autonomy"
  "fatigue"
  "inbox"
  "cross-room"
  "rubber-stamp"
  "earned autonomy"
  "user study"
  "human study"
)

mkdir -p "$OUT/fragments"
STATUS="$OUT/status.tsv"
printf 'kind\tquery\tstatus\tresults\tfile\n' >"$STATUS"
FAILED=0

slug() { printf '%s' "$1" | tr -cs 'a-zA-Z0-9' '-' | sed -e 's/^-//' -e 's/-$//'; }

count_json() { node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).length))' "$1"; }

# run_search <kind> <label> <file> <gh search args...>: one search, with one retry on a rate limit.
run_search() {
  local kind="$1" label="$2" file="$3"
  shift 3
  local err="$file.stderr" attempt status results
  for attempt in 1 2; do
    if gh search "$@" >"$file" 2>"$err"; then
      results="$(count_json "$file")"
      printf '%s\t%s\tok\t%s\t%s\n' "$kind" "$label" "$results" "${file#"$OUT"/}" >>"$STATUS"
      rm -f "$err"
      printf '  %-6s %-46s %s\n' "$kind" "$label" "$results"
      return 0
    fi
    if grep -qiE 'rate limit|secondary rate|HTTP 403|HTTP 429' "$err"; then
      status="rate-limited"
      if [ "$attempt" = 1 ]; then
        printf '  %-6s %-46s rate limited, waiting %s s\n' "$kind" "$label" "$RETRY_WAIT_S"
        sleep "$RETRY_WAIT_S"
        continue
      fi
    else
      status="failed: $(head -c 200 "$err" | tr '\n\t' '  ')"
      break
    fi
  done
  printf '%s\t%s\t%s\t\t%s\n' "$kind" "$label" "$status" "${file#"$OUT"/}" >>"$STATUS"
  printf '  %-6s %-46s %s\n' "$kind" "$label" "$status" >&2
  FAILED=$((FAILED + 1))
  return 1
}

REPO_FIELDS=fullName,description,url,updatedAt,stargazersCount,isFork
CODE_FIELDS=repository,path,url,textMatches

echo "scan $STAMP: $OUT"
if ! command -v gh >/dev/null; then
  echo "gh is not installed, so nothing was scanned" >&2
  exit 1
fi

echo "the field: repositories naming the hackathon"
run_search field "$HACKATHON hackathon" "$OUT/field.json" \
  repos "$HACKATHON" hackathon --match readme,description --limit 300 --json "$REPO_FIELDS"

echo "repositories naming the hackathon and a term"
for term in "${TERMS[@]}"; do
  name="$(slug "$term")"
  sleep "$REPO_PACE_S"
  run_search narrow "$HACKATHON hackathon + $term" "$OUT/narrow-$name.json" \
    repos "$HACKATHON" hackathon "$term" --match readme,description --limit 100 --json "$REPO_FIELDS"
  sleep "$REPO_PACE_S"
  run_search wide "$HACKATHON + $term" "$OUT/wide-$name.json" \
    repos "$HACKATHON" "$term" --match readme,description --limit 100 --json "$REPO_FIELDS"
done

echo "READMEs matching the hackathon and a term"
for term in "${TERMS[@]}"; do
  name="$(slug "$term")"
  sleep "$CODE_PACE_S"
  run_search code "$HACKATHON + $term" "$OUT/code-$name.json" \
    code "$HACKATHON" "$term" --filename README.md --limit 100 --json "$CODE_FIELDS"
done

# Leads: narrow hits count as they are. Wide and code hits count only with a sign they're about this field.
node - "$OUT" <<'NODE'
const fs = require("fs");
const path = require("path");
const dir = process.argv[2];
const read = (file) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
  } catch {
    return [];
  }
};
const field = new Set(read("field.json").map((row) => row.fullName));
const relevant = /\bswitch\b.*\b(agent|room|mattermost|slack)|approval|human.in.the.loop|hackathon/i;
const namesHackathon = /flip the switch.{0,60}hackathon|hackathon.{0,60}flip the switch|wemakedevs/i;
// Which single word to read each lead for, from the term that surfaced it.
const readWord = {
  "approval-inbox": "inbox",
  inbox: "inbox",
  rubber: "rubber",
  "rubber-stamp": "rubber",
  drill: "drill",
  autonomy: "autonomy",
  "earned-autonomy": "autonomy",
  fatigue: "fatigue",
  "cross-room": "room",
  "user-study": "study",
  "human-study": "study",
};
const leads = new Map();
const add = (name, description, term, kind) => {
  const lead = leads.get(name) ?? {
    name,
    url: `https://github.com/${name}`,
    description: description ?? "",
    inField: field.has(name),
    terms: [],
  };
  if (!lead.description && description) lead.description = description;
  if (!lead.terms.includes(term)) lead.terms.push(term);
  lead.kinds = [...new Set([...(lead.kinds ?? []), kind])];
  leads.set(name, lead);
};
let dropped = 0;
for (const file of fs.readdirSync(dir)) {
  const match = file.match(/^(narrow|wide|code)-(.+)\.json$/);
  if (!match) continue;
  const [, kind, term] = match;
  for (const row of read(file)) {
    if (kind === "code") {
      const name = row.repository?.nameWithOwner;
      const text = (row.textMatches ?? []).map((m) => m.fragment).join(" ");
      if (name && (field.has(name) || namesHackathon.test(text))) add(name, row.repository?.description, term, kind);
      else dropped += 1;
    } else if (kind === "wide") {
      if (field.has(row.fullName) || relevant.test(row.description ?? "")) add(row.fullName, row.description, term, kind);
      else dropped += 1;
    } else {
      add(row.fullName, row.description, term, kind);
    }
  }
}
const rank = (lead) => (lead.inField ? 100 : 0) + (lead.kinds.includes("narrow") ? 50 : 0) + lead.terms.length;
const sorted = [...leads.values()].sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name));
fs.writeFileSync(path.join(dir, "leads.json"), JSON.stringify(sorted, null, 2));
const reads = sorted.flatMap((lead) => [...new Set(lead.terms.map((term) => readWord[term]))].map((word) => `${lead.name} ${word}`));
fs.writeFileSync(path.join(dir, "read-list.txt"), `${reads.join("\n")}\n`);
process.stdout.write(`field ${field.size}; ${sorted.length} leads; ${dropped} rows dropped as idiom noise\n`);
NODE

# What each lead's files say about the words that surfaced it, as search returns it: matching fragments,
# not whole READMEs. docs/competition-scan.md says so.
TOTAL_READS="$(wc -l <"$OUT/read-list.txt")"
echo "reading: $TOTAL_READS queries wanted, limit $READ_LIMIT"
FOUND_ANY=0
head -n "$READ_LIMIT" "$OUT/read-list.txt" >"$OUT/read-list-used.txt"
while read -r repo word; do
  [ -n "$repo" ] || continue
  sleep "$CODE_PACE_S"
  file="$OUT/fragments/$(slug "$repo")-$word.json"
  if run_search read "$repo: $word" "$file" code "$word" --repo "$repo" --limit 20 --json "$CODE_FIELDS"; then
    [ "$(count_json "$file")" -gt 0 ] && FOUND_ANY=1
  fi
done <"$OUT/read-list-used.txt"

# Every reading query coming back empty means the reading is broken, not that the field is empty. An
# earlier version of this script did exactly that and still said "all queries ok".
if [ "$TOTAL_READS" -gt 0 ] && [ "$FOUND_ANY" = 0 ]; then
  echo "every reading query came back empty, so the reading step is not working" >&2
  FAILED=$((FAILED + 1))
fi
if [ "$TOTAL_READS" -gt "$READ_LIMIT" ]; then
  echo "note: $((TOTAL_READS - READ_LIMIT)) reading queries were not made because of the limit" >&2
fi

echo
echo "status: $STATUS"
if [ "$FAILED" -gt 0 ]; then
  echo "$FAILED queries FAILED or were rate limited. See the status file. Treat this scan as incomplete." >&2
  exit 1
fi
echo "all queries ok"
