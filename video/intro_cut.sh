#!/usr/bin/env bash
# The team's intro, tightened and brightened for the film: the problem (0 to 15.27 s, graded from navy to a vivid blue), then
# straight to "Okay. Enough cartoons. Here's the real thing." (26.1 to 29.0 s). The middle part previewed what the film then
# shows for real. Its own sound is cut at the same two points.
#   bash video/intro_cut.sh   ->  film/public/footage/intro-cut.mp4 and ~/Videos/clearance/audio/intro-sfx-cut.wav
set -euo pipefail
cd "$(dirname "$0")"
A1=15.267; B0=26.1; B1=29.0
G="eq=saturation=1.55:contrast=1.06:brightness=0.015,colorbalance=bs=0.10:bm=0.06:rs=0.05:rh=0.02,vibrance=intensity=0.35"
ffmpeg -loglevel error -y -i film/public/footage/intro.mp4 -filter_complex \
  "[0:v]trim=0:$A1,setpts=PTS-STARTPTS,$G[a];[0:v]trim=$B0:$B1,setpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=1:a=0,fps=30[o]" \
  -map "[o]" -an -c:v libx264 -crf 16 -preset medium -pix_fmt yuv420p film/public/footage/intro-cut.mp4
mkdir -p "$HOME/Videos/clearance/audio"
ffmpeg -loglevel error -y -i "$HOME/Downloads/intro-sfx.wav" -filter_complex \
  "[0:a]atrim=0:$A1,asetpts=PTS-STARTPTS[a];[0:a]atrim=$B0:$B1,asetpts=PTS-STARTPTS[b];[a][b]acrossfade=d=0.04[o]" \
  -map "[o]" "$HOME/Videos/clearance/audio/intro-sfx-cut.wav"
ffprobe -v error -show_entries format=duration -of csv=p=0 film/public/footage/intro-cut.mp4
