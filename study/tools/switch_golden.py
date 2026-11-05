"""Draw each golden case with Switch's real Mattermost renderer. Run through study/tools/regen-golden.sh.

Calls `MattermostAdapter._draw` from the pinned Switch checkout, the same function `post_rich` uses,
and `offered_controls` for the buttons. Writes only to the output path it is given. It needs no
server, database or Mattermost: `_draw` only reads the adapter's escape, limit and markup.

usage: switch_golden.py <switch-dir> <inputs.json> <output.json>
"""

import json
import sys
from pathlib import Path

from switch_core.bridges.collaboration.adapter import RequestCard
from switch_core.bridges.collaboration.mattermost.adapter import MattermostAdapter
from switch_core.bridges.collaboration.session.renderers import RequestReference, offered_controls
from switch_core.sessions.contract import (
    ApprovalContent,
    ApprovalOption,
    Question,
    QuestionOption,
    QuestionsContent,
    SnapshotRequest,
)


def content_for(case_input: dict) -> ApprovalContent | QuestionsContent:
    if case_input["kind"] == "approval":
        return ApprovalContent(
            kind="approval",
            title=case_input["title"],
            detail=case_input["detail"],
            options=[
                ApprovalOption(optionId=f"o{i}", label=o["label"], decision=o["decision"])
                for i, o in enumerate(case_input["options"])
            ],
        )
    q = case_input["question"]
    return QuestionsContent(
        kind="questions",
        title=case_input["title"],
        questions=[
            Question(
                questionId="q1",
                title=q["title"],
                prompt=q["prompt"],
                options=[
                    QuestionOption(optionId=f"o{i}", label=o["label"], description=o["description"])
                    for i, o in enumerate(q["options"])
                ],
                multiSelect=q["multiSelect"],
                allowCustomAnswer=q["allowCustomAnswer"],
            )
        ],
    )


def draw(adapter: MattermostAdapter, case_input: dict) -> dict:
    request = SnapshotRequest.model_validate(
        {
            "requestId": "req-1",
            "turnId": "turn-1",
            "revision": 1,
            "state": "open",
            "expiresAt": None,
            "result": None,
            "decidedBy": None,
            "content": content_for(case_input).model_dump(by_alias=True),
        }
    )
    card = RequestCard(request, RequestReference(token="tok", handle=case_input["handle"]))
    drawn = adapter._draw(card, mention=case_input["mention"] or None, responder=None, controls=True)
    buttons = [c.label for c in offered_controls(request)] if drawn.answerable else []
    return {"text": drawn.text, "answerable": drawn.answerable, "buttons": buttons}


def main() -> None:
    switch_dir, inputs_path, output_path = sys.argv[1:4]
    # Read the file rather than shelling out to git, so this works from any checkout layout.
    sha = (Path(switch_dir) / ".git/HEAD").read_text().strip()
    adapter = object.__new__(MattermostAdapter)
    cases = json.loads(Path(inputs_path).read_text())
    golden = {
        "generated_by": "study/tools/regen-golden.sh, real MattermostAdapter._draw",
        "switch_commit": sha,
        "cases": {case["name"]: draw(adapter, case["input"]) for case in cases},
    }
    Path(output_path).write_text(json.dumps(golden, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {len(golden['cases'])} cases from Switch {sha}")


if __name__ == "__main__":
    main()
