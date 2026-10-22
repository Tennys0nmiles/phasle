"""Decompose a song clip into tiers of one Fourier series fitted to the whole clip.

Every term is a single sine wave that lasts the entire clip: x(t) = sum A_j cos(2 pi f_j t + phi_j),
with f_j on the clip's 1/T frequency grid. Each tier keeps the N strongest terms, where N is
the smallest count whose relative L2 error is at or below the tier's target. Few terms give
a constant drone; rhythm only appears once enough nearby frequencies interfere.

Usage:
  .venv/bin/python -I tools/make_song.py raw/song.wav site/data/song/s001 \
      --start 18.9 --end 38.6 --errors 70,50,30,10,1
"""
import argparse
import base64
import json
import subprocess
from pathlib import Path

import numpy as np

FS = 48000
FADE = 0.15  # seconds
ENV_COLS = 720
SPEC_BINS = 320
SPEC_FMIN, SPEC_FMAX = 30.0, 16000.0
SPEC_DB = 80.0


def load_clip(src, start, end):
    cmd = ["ffmpeg", "-v", "error", "-ss", str(start), "-to", str(end), "-i", str(src),
           "-ac", "1", "-ar", str(FS), "-f", "f32le", "-"]
    x = np.frombuffer(subprocess.run(cmd, check=True, capture_output=True).stdout, dtype=np.float32).astype(np.float64)
    ramp = np.linspace(0, 1, int(FADE * FS))
    x[:len(ramp)] *= ramp
    x[-len(ramp):] *= ramp[::-1]
    return x


def write_mp3(y, path, target_rms):
    y = y * (target_rms / max(np.sqrt(np.mean(y**2)), 1e-12))
    y = y / max(1.0, np.abs(y).max() / 0.98)
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(FS), "-ac", "1", "-i", "-",
           "-codec:a", "libmp3lame", "-b:a", "128k", str(path)]
    subprocess.run(cmd, input=y.astype(np.float32).tobytes(), check=True)
    return y


def envelope(y):
    """Per-column min/max of the waveform as int8 pairs."""
    cols = np.array_split(y, ENV_COLS)
    env = np.array([[c.min(), c.max()] for c in cols])
    return np.clip(np.round(env * 127), -127, 127).astype(np.int8)


def spectrum(amp, freqs, top):
    """Loudest term per log-frequency bin, 0 = no term, else 1..255 over SPEC_DB."""
    edges = np.geomspace(SPEC_FMIN, SPEC_FMAX, SPEC_BINS + 1)
    idx = np.searchsorted(edges, freqs) - 1
    ok = (idx >= 0) & (idx < SPEC_BINS) & (amp > 0)
    peak = np.zeros(SPEC_BINS)
    np.maximum.at(peak, idx[ok], amp[ok])
    db = 20 * np.log10(np.maximum(peak, 1e-20) / top)
    out = np.where(peak > 0, np.clip(np.round(255 * (1 + db / SPEC_DB)), 1, 255), 0)
    return out.astype(np.uint8)


def b64(arr):
    return base64.b64encode(arr.tobytes()).decode()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("out_dir")
    ap.add_argument("--start", type=float, required=True)
    ap.add_argument("--end", type=float, required=True)
    ap.add_argument("--errors", default="70,50,30,10,1", help="target %% error per tier")
    args = ap.parse_args()
    targets = [float(t) for t in args.errors.split(",")]
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("t*.mp3"):
        old.unlink()

    x = load_clip(args.src, args.start, args.end)
    n = len(x)
    X = np.fft.rfft(x)
    freqs = np.fft.rfftfreq(n, 1 / FS)
    # Parseval for a real signal: interior bins stand for a +f and a -f pair.
    weight = np.full(len(X), 2.0)
    weight[0] = 1.0
    if n % 2 == 0:
        weight[-1] = 1.0
    energy = weight * np.abs(X) ** 2
    order = np.argsort(-energy)
    left = np.sqrt(np.maximum(0, 1 - np.cumsum(energy[order]) / energy.sum()))
    amp = weight * np.abs(X) / n  # sine amplitude of each term
    top = amp.max()

    rms = np.sqrt(np.mean(x**2))
    tiers, errors, envs, specs = [], [], [], []
    for i, target in enumerate(targets, 1):
        k = int(np.argmax(left <= target / 100)) + 1
        keep = np.zeros_like(X)
        keep[order[:k]] = X[order[:k]]
        y = np.fft.irfft(keep, n)
        err = 100 * np.linalg.norm(x - y) / np.linalg.norm(x)
        tiers.append(k)
        errors.append(round(float(err), 2))
        played = write_mp3(y, out / f"t{i}.mp3", rms)
        envs.append(envelope(played))
        kept_amp = np.zeros_like(amp)
        kept_amp[order[:k]] = amp[order[:k]]
        specs.append(spectrum(kept_amp, freqs, top))
        print(f"tier {i}: {k:7d} sine waves  error {err:6.2f}%  (target {target}%)")
    played = write_mp3(x, out / "full.mp3", rms)
    envs.append(envelope(played))
    specs.append(spectrum(amp, freqs, top))

    meta = {"duration": round(n / FS, 3), "terms_total": len(X), "tiers": tiers, "errors": errors}
    (out / "meta.json").write_text(json.dumps(meta, indent=1))
    viz = {"cols": ENV_COLS, "bins": SPEC_BINS, "fmin": SPEC_FMIN, "fmax": SPEC_FMAX,
           "env": [b64(e) for e in envs], "spec": [b64(s) for s in specs]}
    (out / "viz.json").write_text(json.dumps(viz))
    print(f"{len(X)} possible terms -> {out}")


if __name__ == "__main__":
    main()
