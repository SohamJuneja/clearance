#!/usr/bin/env bash
# The whole film from data, in one go. VOICE=narrator (default) or VOICE=owner (after owner_takes.py). TAG names the output.
#   bash video/rebuild.sh            ->  ~/Videos/clearance/clearance-<TAG>.mp4 and a 720p phone copy
set -euo pipefail
cd "$(dirname "$0")"
TOOLS="${FILM_TOOLS:?set FILM_TOOLS to the folder of the film toolkit scripts}"
PY="${FILM_PY:-$HOME/.pyenv/versions/3.10.13/bin/python}"
MUSIC_PY="${MUSIC_PY:-$HOME/Videos/debrief/.venv-music/bin/python}"
OUT="$HOME/Videos/clearance"
TAG="${TAG:-$(date +%H%M)}"
TAKES=narration/takes
[ "${VOICE:-narrator}" = owner ] && TAKES=narration/owner

python3 facts.py --fill
python3 build_film.py
python3 "$TOOLS/vo_timeline.py" narration.json "$TAKES" --film film/film.json --write --out narration | tail -1
[ "${VOICE:-narrator}" = owner ] && python3 faces.py
"$PY" "$TOOLS/captions.py" narration/vo_full.wav narration/script.txt --out film/public/captions | tail -1
python3 -c "import json; p='film/film.json'; f=json.load(open(p)); f['captions']='captions/captions.json'; json.dump(f, open(p,'w'), indent=1, ensure_ascii=False)"
"$MUSIC_PY" music.py
python3 "$TOOLS/cues_from_film.py" film/film.json --captions film/public/captions/captions.json --write --out sfx_cues.json | tail -1
python3 sfx_paper.py "$OUT/audio/sfx" >/dev/null
python3 cue_fix.py
python3 "$TOOLS/sfx_synth.py" track sfx_cues.json "$OUT/audio/sfx_track.wav" | tail -1
mkdir -p "$OUT/tmp"
(cd film && TMPDIR="$OUT/tmp" npx remotion render src/index.ts Film "$OUT/film-$TAG.mp4" --log=error)
python3 "$TOOLS/mix.py" mix.json --mux "$OUT/film-$TAG.mp4" "$OUT/clearance-$TAG.mp4" | tail -1
ffmpeg -loglevel error -y -i "$OUT/clearance-$TAG.mp4" -vf scale=1280:-2 -c:v libx264 -crf 28 -preset medium -c:a aac -b:a 128k "$OUT/clearance-$TAG-720p.mp4"
ls -la "$OUT/clearance-$TAG.mp4" "$OUT/clearance-$TAG-720p.mp4"
