# A Canva connection for Switch

Written for Track 03 (Switch's open issue #833), and kept here instead of being sent upstream. We decided on Nov 7 not to
open the pull request: the issue asks for a video of the connection working against a real Canva app, and we had no Canva
developer app to record it with. So it isn't a Track 03 entry.

## What's here

| File | What it is |
|---|---|
| `canva-connection.patch` | One commit against Switch `13f6a2c8`: the catalog entry (`connection.yaml`, in the shape of Switch's Airtable entry), its skill, the tests, a setup doc and the design-doc lines |
| `canva-gate.mjs` | A probe that signs in to Canva the way Switch's OAuth adapter does and says whether Canva's MCP server will talk to a developer app. It never prints a token |
| `canva-gate.check.mjs` | The probe's own check, against a stand-in for Canva |

## What's tested, and what isn't

- The six Switch test files the patch touches pass with it applied: 235 tests (rerun Nov 7).
- The probe's check passes 5 of 5, against the stand-in. It has never talked to the real Canva.
- **Never tested against a real Canva app.** Values only a real app can show (token lifetime, whether refresh rotates,
  revocation, whether the read level is enforced, the real tool names) are marked `TO MEASURE` in the patch. They hold
  provisional values from Canva's documentation, so the entry loads, and they say so.

## Trying it

In a clone of Switch:

```bash
git checkout -b canva-connection 13f6a2c8
git am /path/to/clearance/spikes/track03/canva-connection.patch
```

The probe needs a Canva developer app's client id and secret in a file outside any repo:
`node spikes/track03/canva-gate.mjs --client ~/.config/canva-track03/client.json`.
[`docs/build/track03.md`](../../docs/build/track03.md) has the full plan, the competing pull requests as of Nov 6, and the
hand checks a real entry would still need.
