#!/usr/bin/env python3
"""Two effects of this film's own, synthesised (nothing licensed): a rubber stamp and a sheet torn off a pad.

    python3 video/sfx_paper.py ~/Videos/clearance/audio/sfx     -> stamp.wav, tear.wav (cued by stem in sfx_cues.json)
"""
import os
import sys
import wave

import numpy as np

SR = 48000
rng = np.random.default_rng(23)


def band(x, lo, hi):
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    X[(f < lo) | (f > hi)] = 0
    return np.fft.irfft(X, len(x))


def write(path, x):
    x = x / (np.max(np.abs(x)) + 1e-9) * 0.9
    st = np.stack([x, x * 0.96], axis=1)
    with wave.open(path, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((st * 32767).astype("<i2").tobytes())


def stamp():
    n = int(0.42 * SR)
    t = np.arange(n) / SR
    thump = np.sin(2 * np.pi * (95 * t - 60 * t * t)) * np.exp(-t * 18)          # the hand and the desk
    slap = band(rng.standard_normal(n), 900, 5200) * np.exp(-t * 60)               # rubber on paper
    body = band(rng.standard_normal(n), 180, 700) * np.exp(-t * 28) * 0.5          # the wooden handle
    x = 1.0 * thump + 0.55 * slap + body
    x[: int(0.002 * SR)] *= np.linspace(0, 1, int(0.002 * SR))
    return x


def tear():
    n = int(0.55 * SR)
    t = np.arange(n) / SR
    crackle = rng.standard_normal(n) * (rng.random(n) < 0.08)                       # the perforation giving way, hole by hole
    rip = band(rng.standard_normal(n), 1200, 7000)
    env = np.minimum(1, t / 0.05) * np.exp(-np.maximum(0, t - 0.32) * 14)
    x = (0.7 * band(crackle, 600, 8000) + 0.45 * rip) * env
    return x


if __name__ == "__main__":
    out = os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else "~/Videos/clearance/audio/sfx")
    os.makedirs(out, exist_ok=True)
    write(os.path.join(out, "stamp.wav"), stamp())
    write(os.path.join(out, "tear.wav"), tear())
    print(f"wrote stamp.wav, tear.wav in {out}")
