"""Decompose a song clip into tiers of "strongest N sinusoids per moment".

Each STFT frame keeps only its N loudest spectral peaks (ranked by A-weighted
magnitude, so the terms you hear first are the ones your ear notices first).
A peak keeps its whole Hann main lobe (+-2 bins), so the resynthesised term is
a sinusoid at its true frequency, not snapped to a bin centre.

Usage:
  .venv/bin/python -I tools/make_song.py raw/song.wav site/data/song/s001 \
      --start 18.9 --end 38.6 --tiers 1,2,4,8,16,32
"""
import argparse
import json
import subprocess
from pathlib import Path

import numpy as np
from scipy.signal import ShortTimeFFT
from scipy.signal.windows import hann

FS = 48000
NFFT = 4096
HOP = 1024
LOBE = 2  # Hann main lobe half-width in bins
FADE = 0.15  # seconds
VIZ_FMIN, VIZ_FMAX = 40.0, 12000.0


def load_clip(src, start, end):
    cmd = ["ffmpeg", "-v", "error", "-ss", str(start), "-to", str(end), "-i", str(src),
           "-ac", "1", "-ar", str(FS), "-f", "f32le", "-"]
    x = np.frombuffer(subprocess.run(cmd, check=True, capture_output=True).stdout, dtype=np.float32).astype(np.float64)
    ramp = np.linspace(0, 1, int(FADE * FS))
    x[:len(ramp)] *= ramp
    x[-len(ramp):] *= ramp[::-1]
    return x


def a_weight(f):
    f2 = np.maximum(f, 1.0) ** 2
    ra = 12194.0**2 * f2**2 / ((f2 + 20.6**2) * np.sqrt((f2 + 107.7**2) * (f2 + 737.9**2)) * (f2 + 12194.0**2))
    return ra / ra.max()


def ranked_peaks(S, freqs):
    """Per frame: peak bins sorted by A-weighted magnitude, loudest first."""
    mag = np.abs(S)
    weighted = mag * a_weight(freqs)[:, None]
    is_peak = np.zeros_like(mag, dtype=bool)
    is_peak[1:-1] = (mag[1:-1] > mag[:-2]) & (mag[1:-1] >= mag[2:])
    out = []
    for j in range(S.shape[1]):
        bins = np.flatnonzero(is_peak[:, j])
        out.append(bins[np.argsort(-weighted[bins, j])])
    return out


def keep_top(S, peaks, n):
    mask = np.zeros(S.shape, dtype=bool)
    for j, bins in enumerate(peaks):
        for b in bins[:n]:
            mask[max(b - LOBE, 0):b + LOBE + 1, j] = True
    return S * mask


def write_mp3(y, path, target_rms):
    y = y * (target_rms / max(np.sqrt(np.mean(y**2)), 1e-12))
    y = y / max(1.0, np.abs(y).max() / 0.98)
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(FS), "-ac", "1", "-i", "-",
           "-codec:a", "libmp3lame", "-b:a", "128k", str(path)]
    subprocess.run(cmd, input=y.astype(np.float32).tobytes(), check=True)


def viz_bytes(S, peaks, freqs, kmax):
    """uint8 [frame][rank][freq, level]: freq on a log scale, level over a 60 dB range."""
    mag = np.abs(S) + 1e-12
    logmag = np.log(mag)
    top_db = 20 * np.log10(mag.max())
    out = np.zeros((S.shape[1], kmax, 2), dtype=np.uint8)
    for j, bins in enumerate(peaks):
        for r, b in enumerate(bins[:kmax]):
            a, m, c = logmag[max(b - 1, 0), j], logmag[b, j], logmag[min(b + 1, len(freqs) - 1), j]
            denom = a - 2 * m + c
            f = (b + (0.5 * (a - c) / denom if denom < 0 else 0.0)) * FS / NFFT
            fpos = np.log(np.clip(f, VIZ_FMIN, VIZ_FMAX) / VIZ_FMIN) / np.log(VIZ_FMAX / VIZ_FMIN)
            level = np.clip((20 * np.log10(mag[b, j]) - top_db + 60) / 60, 0, 1)
            out[j, r] = (round(fpos * 255), max(1, round(level * 255)))
    return out.tobytes()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("out_dir")
    ap.add_argument("--start", type=float, required=True)
    ap.add_argument("--end", type=float, required=True)
    ap.add_argument("--tiers", default="1,2,4,8,16,32")
    args = ap.parse_args()
    tiers = [int(t) for t in args.tiers.split(",")]
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    x = load_clip(args.src, args.start, args.end)
    sft = ShortTimeFFT(hann(NFFT, sym=False), hop=HOP, fs=FS, mfft=NFFT)
    S = sft.stft(x)
    freqs = sft.f
    peaks = ranked_peaks(S, freqs)
    rms = np.sqrt(np.mean(x**2))

    errors = []
    for i, n in enumerate(tiers, 1):
        y = sft.istft(keep_top(S, peaks, n), k1=len(x))
        err = float(np.linalg.norm(x - y) / np.linalg.norm(x))
        errors.append(round(100 * err, 1))
        write_mp3(y, out / f"t{i}.mp3", rms)
        print(f"tier {i}: {n:3d} terms/frame  error {100 * err:5.1f}%")
    write_mp3(x, out / "full.mp3", rms)

    (out / "peaks.bin").write_bytes(viz_bytes(S, peaks, freqs, max(tiers)))
    meta = {
        "duration": round(len(x) / FS, 3),
        "tiers": tiers,
        "errors": errors,
        "viz": {"frames": S.shape[1], "kmax": max(tiers), "hop": HOP / FS,
                "t0": float(sft.t(len(x))[0]), "fmin": VIZ_FMIN, "fmax": VIZ_FMAX},
    }
    (out / "meta.json").write_text(json.dumps(meta, indent=1))
    print(f"{S.shape[1]} frames -> {out}")


if __name__ == "__main__":
    main()
