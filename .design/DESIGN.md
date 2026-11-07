# Clearance site: design system

The project page in `site/`. `pnpm site:build` fills every number from the results table that `eval/report.ts` writes into
README.md, and writes `site/dist/index.html` (any static host) and `site/dist/artifact.html` (a shareable link).

## Taste

IS: **exacting** (hard edges, a form grid, monospace numbers), **accountable** (real screenshots, the caveat beside every number,
nothing hidden behind hover), **wry** (a stamp that says REQUESTER on a refused approval; the page hashing itself into a ledger).

NEVER: corporate SaaS (gradient blobs, glassy 3-up cards), hacker cliché (matrix rain, neon, padlocks), fear-selling (alarm red).

Feel in motion: heavy and precise. Things arrive with weight and stop dead. No bounce, no float.

Material: ledger stock with paper tooth, carbonless copies (white, canary, pink), stamp ink multiplied over paper, typewriter and
terminal monospace, real chat screenshots pinned like documents.

Lines not to cross: no invented UI passed off as the product; no number that isn't filled by script, or without its caveat; one
signature effect per screen; everything readable with motion off; no cream + serif + terracotta, no purple-blue gradients, no
near-black + acid green.

## The idea

One request, CLR-0001, in three carbon copies, each going where Clearance really sends it: the white copy to the room it was asked
in, canary to the approver's direct room, pink to the ledger. The stamp is the decision. The headline's one rule is a ledger's
double underline under "can't".

## Tokens

| Token | Value | Use |
|---|---|---|
| `--paper` | #ECEEE7 | ledger stock, the page |
| `--paper-deep` | #E1E5DC | ruled bands |
| `--rule` | #B9C8D6 | blue ledger rules, field lines |
| `--margin` | #D79292 | the red margin rule on forms and the record |
| `--copy-white` / `--copy-canary` / `--copy-pink` | #FBFBF7 / #F6E58F / #F3C8D2 | the three copies |
| `--ink` / `--ink-soft` / `--ink-faint` | #1B1E23 / #484E57 / #6E747C | text |
| `--stamp-red` | #C2283A | refusals, denials, the double rule, the negative result |
| `--stamp-violet` | #4232A4 | HELD, links, focus |

Type: Archivo (variable width and weight, Google Fonts, OFL) for display and body; width is the contrast: headline at 112%, stamps
and figures condensed to 70-82%, body at 96-100%. IBM Plex Mono (OFL) for IDs, hashes, labels, the terminal and the ledger.

Scale: `--step--1` 0.78-0.84rem, `--step-0` 1-1.09rem, `--step-1` 1.2-1.45rem, `--step-2` 1.7-2.8rem, hero 2.5-7.4rem, all `clamp()`.

Radius: square. 2px only on focus rings. Cards are paper, so they have edges, not corners.

Spacing: sections `clamp(56px, 8vw, 112px)` block padding; gutter `max(16px, env(safe-area-inset-*))`; content max 1240px.

## Motion

| Name | Value | Where |
|---|---|---|
| `--slam` | cubic-bezier(0.7, 0, 0.84, 0), 300 ms | a stamp: drops from 1.75x, squashes once, settles |
| jolt | 220 ms ease-out | the stack under the hero stamp: 3px down, 1px back |
| `--arrive` | cubic-bezier(0.16, 1, 0.3, 1), 360-620 ms | copies sliding, the double rule drawing, stage fades |
| decode | 70 ms per character | the ledger head's hash, once, at stage 6 |

Rules:
- The hero plays once on load, in CSS: stamp at 900 ms, jolt at 1075 ms, double rule at 1250 ms. No script needed.
- The workflow is a sticky stage beside six steps, on screens 961px and wider. A step crossing the middle of the screen sets the
  stage; stamps slam as their stage is reached. Narrower, or with reduced motion, every stage shows at once, in reading order.
- Nothing else animates on scroll. No fade-up on sections.
- Reduced motion: no animation or transition anywhere; stamps and rules are simply there.

## Components

- Masthead: the wordmark as a rubber stamp, mono section links, GitHub as a small ruled button. Sticky, under the safe area.
- Copy (`.copy`): perforated top, red margin rule, mono field labels on ruled lines. Back copies are offset and slightly rotated.
- Stamp (`.stamp`): inline SVG through the `#ink` filter (speckle and wobble), multiplied over paper.
- Figures: three numbers with their caveat in mono beneath, filled by the build.
- Record: the results table on ruled stock with a margin rule; the negative result in pink with its number in stamp red.
- Evidence: real screenshots pinned like documents with a strip of tape; the demo video beside the Desk.
- Footer: the page hashes its own sections into a chain and prints the head.
