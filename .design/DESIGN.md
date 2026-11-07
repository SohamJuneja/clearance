# Clearance site: design system

The project page in `site/`. `pnpm site:build` fills every number from the results table that `eval/report.ts` writes into
README.md, copies the "Run it" commands and the Switch table from the README, bundles Clearance's own classifier and policy
engine with the policy file for "Try it", and writes `site/dist/index.html` (any static host), `site/dist/playground.js` and
`site/dist/artifact.html` (a shareable link, with the engine inlined).

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

Scale: `--step--1` 0.8-0.86rem, `--step-0` 1-1.09rem, `--step-1` 1.2-1.45rem, `--step-2` 1.7-2.8rem, hero 2.5-7.4rem, all `clamp()`.

Radius: square. 2px only on focus rings. Cards are paper, so they have edges, not corners.

Spacing: sections `clamp(56px, 8vw, 112px)` block padding; gutter `max(16px, env(safe-area-inset-*))`; content max 1240px.

## Motion

| Name | Value | Where |
|---|---|---|
| `--slam` | cubic-bezier(0.7, 0, 0.84, 0), 140 ms | a stamp: drops from 1.75x and stops dead; one frame of squash on contact, ink settles over 300 ms; no overshoot |
| jolt | 60 ms | the stack under the hero stamp: 2px down, and it stays there |
| `--arrive` | cubic-bezier(0.16, 1, 0.3, 1), 360-620 ms | copies sliding, the double rule drawing, stage fades |
| ledger rows | 80 ms apart | the ledger's rows, once, at stage 6, as the pink copy comes up as the ledger |

Rules:
- The hero plays once on load, in CSS: stamp at 900 ms, contact and jolt at 1040 ms, double rule at 1250 ms. No script needed.
  The form sits beside the headline, so at 1280x720 the Approve row and the stamp land above the fold.
- The workflow is a sticky stage beside six steps, on screens 961px and wider. A step crossing the middle of the screen sets the
  stage; stamps slam as their stage is reached. The chat (a real crop), the gate's recorded call and the ledger take turns in
  one slot above the copies. Sam's canary copy comes out below the room's copy, never over its REQUESTER stamp, and at the last
  step the pink copy leaves the stack and comes up as the ledger. The stage is capped at the screen's height less 100px and
  drawn smaller when it doesn't fit. Narrower, or with reduced motion, every stage shows at once, after the steps, and nothing
  sticks.
- In "Try it" the answer's stamp slams when the answer changes. Nothing else animates on scroll. No fade-up on sections.
- Reduced motion: no animation or transition anywhere; stamps and rules are simply there.

## Components

- Masthead: the wordmark as a rubber stamp, mono section links, GitHub as a small ruled button. Sticky, under the safe area. On
  a phone the links get a row of their own.
- Folder tab (`.tab`): each section's label, a tab in a copy's colour (white, canary, pink in turn) sitting on the section's rule,
  with a mono note at the rule's right end. Headings vary with what the section is: wide (an idea), a form's title box (a tool),
  stamp-condensed (Switch, Exhibits), a ledger's double rule (Results).
- Copy (`.copy`): perforated top, red margin rule, mono field labels on ruled lines. Back copies are offset and slightly rotated.
  Every drawn form says what it's drawn from and where the real one is.
- Stamp (`.stamp`, `.vstamp`): inline SVG or an HTML box through the `#ink` filter (speckle and wobble), multiplied over paper.
- Figures: three numbers with their caveat in mono beneath, filled by the build. Caveats in `--ink-soft`, at least 12.5px. A good
  zero is ink; stamp red is for the negative result.
- Route (How it works): the request's path as one ruled line, Switch's stations above it in violet, Clearance's below in ink,
  each numbered on the line, with what leaves it and the code that does it. Below 1100px the line runs down the left.
- Try it: Form CLR-2, a ruled textarea, and a canary answer slip with a stamp, filled first by the build from core and then live
  by the engine in the browser. The examples are a ruled table of core's answers, each a button.
- Switch: the README's capability table as numbered lines S1, S2, ..., the Switch terms in violet mono, the code linked.
- Exhibits: real screenshots framed flat with an EXHIBIT A, B, C label. No tape and no rotation, which would blur them.
- Record: the results table on ruled stock with a margin rule; the negative result in pink with its number in stamp red; a key
  to its terms beneath; on a phone each row is a block of labelled cells.
- Run it: the README's commands as ink lines with copy buttons (clipboard, or the text selected when the clipboard refuses).
- Footer: links in mono ink; the page hashes its own sections into a chain and prints the head.
