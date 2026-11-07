# The film

The demo film, rebuilt from code: a changed line or number means re-running these steps, not editing a timeline. Renders and
large audio go to `~/Videos/clearance/`. Every number comes from the results table `pnpm eval:report` writes into README.md,
through `facts.py`; facts about the world come from `cited.json`, each shown with its source.

```bash
python3 video/cut.py                    # footage from the real takes in docs/media/raw/takes, no captions burned in
python3 video/facts.py --fill           # narration.json from narration.src.json, numbers filled from the results
python3 video/build_film.py             # film/film.json: scenes, stamps on the frames their steps happened, effect cues
# voice: the narrator (Chatterbox) or the owner's own recording
python tts_takes.py video/narration.json --ref video/refs/narrator.wav --out video/narration/takes
python video/owner_takes.py ~/Downloads/clearance-vo.mp4                 # owner: cuts his best take of every line
python3 video/owner_tighten.py ~/Downloads/clearance-vo.mp4             # owner: long pauses shortened, voice and face at 1.07x
python vo_timeline.py video/narration.json <takes dir> --film video/film/film.json --write --out video/narration
python3 video/faces.py                  # owner only: his first line and the close full frame, a bubble on every other line
python captions.py video/narration/vo_full.wav video/narration/script.txt --out video/film/public/captions
~/Videos/debrief/.venv-music/bin/python video/music.py                  # the score, timed to the voice
python cues_from_film.py video/film/film.json --captions video/film/public/captions/captions.json --write --out video/sfx_cues.json
python3 video/sfx_paper.py && python sfx_synth.py track video/sfx_cues.json ~/Videos/clearance/audio/sfx_track.wav
cd video/film && npx remotion render src/index.ts Film ~/Videos/clearance/film.mp4
python mix.py video/mix.json --mux ~/Videos/clearance/film.mp4 ~/Videos/clearance/clearance-final.mp4
```

`tts_takes.py`, `vo_timeline.py`, `captions.py`, `cues_from_film.py`, `sfx_synth.py` and `mix.py` are the film toolkit's scripts.
`bash video/rebuild.sh` runs all of it (`VOICE=owner` for the owner's takes, which also captions his own wording).

The owner's takes: `owner_takes.py` matches each script line to the recording letter by letter, with numbers in words, so a
misheard "Open Code" or "71 %" can't push a take's first words out of the cut. Each face clip keeps up to a second of picture
before the voice, and `faces.py` trims it so the first spoken frame lands on the voice's, in full-frame shots and bubbles alike.
`owner_tighten.py` then cuts long pauses inside a line down to a quarter second and plays voice and picture at 1.07x, the same
seconds out of both, so his lips stay on his voice and the film stays under four minutes. A take that misstates a figure is
left out (`owner_skip` in `narration.src.json`, with why): his line 3 said eighty-seven percent where the source says 80%, so
the sourced card carries that beat on its own. His takes and face clips stay out of git.

The Wispr Flow beat has one line in the narrator's synthetic voice, "We built all of this by voice, with Wispr Flow",
at the owner's choice: he asked for a line there after recording, and `owner_extra.py` takes his own clip instead if he records one.

The team's intro is tightened by `intro_cut.sh` (the middle part previewed what the film then shows for real) and graded
brighter; its own sound is cut at the same points. The Wispr Flow beat shows Soham's Wispr Flow app with its dictation list
blurred, since it holds messages that aren't about this project, and the app's own totals.

What's real and what's labelled: the product footage is real takes of real agents in real Switch rooms on Mattermost, with
people's presses scripted and the company synthetic, which every footage scene says. Sped-up stretches carry their speed on
screen. Paper forms in the drawn scenes are drawn from a real card and say so. The opening clip is the team's own animated intro.
