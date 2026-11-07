"""The film's own score, composed here and rendered from a General MIDI SoundFont: nothing licensed, nothing a recording could match.

A small paperwork ensemble. Under the problem it leans minor (Dm Bb F C): plucked bass, a soft pad, and a side-stick that ticks
like a clock on the wall. On "Clearance puts it back" a timpani lands with the stamp and the same progression turns major
(F C Dm Bb): a marimba carries the tune over moving eighths and a light groove. Under the results it lifts, the tune doubled an
octave up, and it resolves on a long F under the end card. The timing follows the voice timeline, so the turn lands on its scene.

    ~/Videos/debrief/.venv-music/bin/python video/music.py   ->  ~/Videos/clearance/audio/score.wav
"""

from __future__ import annotations

import json
import os
import wave

import numpy as np
import tinysoundfont

SR = 48000
BPM = 96
BEAT = 60 / BPM
BAR = 4 * BEAT
SF2 = os.environ.get("CLEARANCE_SF2", "/usr/share/sounds/sf2/TimGM6mb.sf2")
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.expanduser("~/Videos/clearance/audio")

# (bass, triad) in MIDI
Dm, Bb, F, C = (38, (62, 65, 69)), (34, (62, 65, 70)), (41, (60, 65, 69)), (36, (60, 64, 67))
MINOR = [Dm, Bb, F, C]
MAJOR = [F, C, Dm, Bb]
# the tune, bar by bar: (beat offset, note, beats)
TUNE_A = [[(0, 72, 1), (1, 69, 1), (2, 72, 1), (3, 77, 1)], [(0, 76, 2), (2, 72, 2)], [(0, 74, 1), (1, 72, 1), (2, 69, 2)], [(0, 70, 3), (3, 72, 1)]]
TUNE_B = [[(0, 77, 1.5), (1.5, 76, 0.5), (2, 72, 2)], [(0, 79, 2), (2, 76, 2)], [(0, 74, 1), (1, 76, 1), (2, 77, 2)], [(0, 74, 4)]]

MARIMBA, PIZZ, PAD, TIMPANI = 12, 45, 89, 47
CH = {"marimba": 0, "pizz": 1, "pad": 2, "timp": 3, "drums": 9}
KICK, STICK, HAT, RIDE = 36, 37, 42, 51


def events(total: float, turn: float, lift: float, settle: float):
    """(start s, channel, MIDI note, length s, velocity)"""
    out = []
    end_bar = int((total - 5) / BAR)
    turn_bar = max(1, round(turn / BAR))
    lift_bar = int(lift / BAR)
    settle_bar = int(settle / BAR)
    for b in range(end_bar + 1):
        t0 = b * BAR
        major = b >= turn_bar
        lifted = lift_bar <= b < settle_bar
        last = b == end_bar
        bass, triad = (F if last else MAJOR[(b - turn_bar) % 4]) if major else MINOR[b % 4]
        if last:  # resolve on F, rolled, left to ring
            out.append((t0, CH["pizz"], bass - 12, BAR * 2.5, 70))
            for i, n in enumerate((bass + 12, *triad, triad[0] + 12)):
                out.append((t0 + i * 0.16, CH["marimba"], n, BAR * 2.5, 68))
            out.append((t0, CH["pad"], triad[0], BAR * 2.6, 52))
            out.append((t0, CH["pad"], triad[2], BAR * 2.6, 50))
            break
        # pad: the chord held, quiet
        for n in triad:
            out.append((t0, CH["pad"], n - 12 if not major else n, BAR * 1.02, 34 if not major else 40))
        # bass: plucked on 1 and 3 (and the and of 4 once it's major)
        for off in ((0, 2) if not major else (0, 2, 3.5)):
            out.append((t0 + off * BEAT, CH["pizz"], bass, BEAT * 0.9, 74 if not major else 82))
        # the clock: a side-stick on every beat under the problem; a groove after the turn
        if not major:
            for k in range(4):
                out.append((t0 + k * BEAT, CH["drums"], STICK, 0.1, 34 + (8 if k == 0 else 0)))
        else:
            for k in range(8):
                out.append((t0 + k * BEAT / 2, CH["drums"], HAT, 0.08, 40 + (10 if k % 2 == 0 else 0) + (10 if lifted else 0)))
            for k in ((0, 2) if not lifted else (0, 1, 2, 3)):
                out.append((t0 + k * BEAT, CH["drums"], KICK, 0.15, 62 if lifted else 54))
            out.append((t0 + 3 * BEAT, CH["drums"], STICK, 0.1, 46))
        # the stamp: a timpani hit on the turn
        if b == turn_bar:
            out.append((t0, CH["timp"], 41, BAR, 110))
            out.append((t0, CH["timp"], 29, BAR, 100))
        if not major:
            # a sparse answer from the marimba every other bar, low and quiet
            if b % 2 == 1:
                out.append((t0 + 2 * BEAT, CH["marimba"], triad[2], BEAT * 2, 40))
            continue
        # moving eighths: the chord, up and back
        arp = [bass + 12, triad[0], triad[1], triad[2], triad[1] + 12, triad[2], triad[1], triad[0]]
        for i, n in enumerate(arp):
            out.append((t0 + i * BEAT / 2, CH["marimba"], n, BEAT * 0.45, 44 + (6 if i % 4 == 0 else 0)))
        tune = TUNE_A if ((b - turn_bar) // 4) % 2 == 0 else TUNE_B
        for off, n, beats in tune[(b - turn_bar) % 4]:
            out.append((t0 + off * BEAT, CH["marimba"], n, beats * BEAT, 72 if lifted else 60))
            if lifted:
                out.append((t0 + off * BEAT, CH["marimba"], n + 12, beats * BEAT, 58))
    return out


def render(evts, seconds: float) -> np.ndarray:
    sf = tinysoundfont._tinysoundfont.SoundFont(SF2)
    sf.set_output(tinysoundfont._tinysoundfont.OutputMode.StereoInterleaved, SR, -6.0)
    sf.channel_set_preset_number(CH["marimba"], MARIMBA, 0)
    sf.channel_set_preset_number(CH["pizz"], PIZZ, 0)
    sf.channel_set_preset_number(CH["pad"], PAD, 0)
    sf.channel_set_preset_number(CH["timp"], TIMPANI, 0)
    sf.channel_set_preset_number(CH["drums"], 0, 1)
    sched = sorted([(s, 1, c, n, v) for s, c, n, _, v in evts] + [(s + d, 0, c, n, 0) for s, c, n, d, _ in evts])
    total = int(seconds * SR)
    out = np.zeros((total, 2), dtype=np.float32)
    pos, i = 0, 0
    while pos < total:
        nxt = min(max(int(sched[i][0] * SR) if i < len(sched) else total, pos), total)
        if nxt > pos:
            buf = np.zeros((nxt - pos) * 2, dtype=np.float32)
            sf.render(memoryview(buf).cast("B"))
            out[pos:nxt] = buf.reshape(-1, 2)
            pos = nxt
        while i < len(sched) and int(sched[i][0] * SR) <= pos:
            _, on, c, n, v = sched[i]
            if on:
                sf.channel_note_on(c, n, v / 127)
            else:
                sf.channel_note_off(c, n)
            i += 1
        if i >= len(sched) and pos < total:
            buf = np.zeros((total - pos) * 2, dtype=np.float32)
            sf.render(memoryview(buf).cast("B"))
            out[pos:] = buf.reshape(-1, 2)
            pos = total
    return out


def reverb(dry: np.ndarray, decay: float = 1.6, wet: float = 0.22) -> np.ndarray:
    rng = np.random.default_rng(11)
    n = int(decay * SR)
    env = np.exp(-6.9 * np.arange(n) / n)
    out = np.empty_like(dry)
    size = 1 << int(np.ceil(np.log2(len(dry) + n)))
    for ch in range(2):
        ir = rng.standard_normal(n) * env
        ir[: int(0.01 * SR)] = 0
        ir /= np.sqrt((ir ** 2).sum())
        wet_ch = np.fft.irfft(np.fft.rfft(dry[:, ch], size) * np.fft.rfft(ir, size), size)[: len(dry)]
        out[:, ch] = (1 - wet) * dry[:, ch] + wet * wet_ch
    return out


def main() -> None:
    tl = json.load(open(os.path.join(HERE, "narration/timeline.json")))
    scenes = {s["scene"] if "scene" in s else s["id"]: s for s in tl["scenes"]}
    total = tl.get("total") or max(s["start"] + s["duration"] for s in tl["scenes"])
    turn = scenes["S06"]["start"]
    lift = scenes["S17"]["start"]
    settle = scenes["S21"]["start"]
    evts = events(total, turn, lift, settle)
    seconds = max(s + d for s, _, _, d, _ in evts) + 3
    audio = reverb(render(evts, seconds))
    audio *= 0.89 / max(1e-6, float(np.abs(audio).max()))
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, "score.wav")
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((audio * 32767).astype("<i2").tobytes())
    print(f"wrote {path}: {seconds:.1f} s, {len(evts)} notes, film {total:.1f} s, turn at {turn:.1f} s, lift at {lift:.1f} s")


if __name__ == "__main__":
    main()
