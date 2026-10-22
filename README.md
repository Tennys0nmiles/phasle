# Phasle

A daily guessing game in the style of Wordle/Heardle, built on Fourier series.

- **Shape**: a picture drawn with one closed line, inner lines included, is rebuilt
  from its biggest Fourier terms (spinning circles, i.e. epicycles). Africa walks the
  coastline and every country border in one Eulerian circuit (odd junctions paired by
  minimum retrace distance), resampled to 4096 points.
- **Song**: the whole clip is one Fourier series. Every term is a single sine wave
  held for the entire clip, and each tier keeps the strongest ones.

Every tier is set by a target error, the same in both modes: **70% → 50% → 30% →
10% → 1%**. A tier's term count is the fewest terms that reach its target. Error is
the RMS distance between reconstruction and original at each moment, over the RMS
size of the original (its distance from the centre, or the waveform itself), so
drawing nothing or silence is 100%. By Parseval that's
`sqrt(energy of dropped terms / total energy)`.

Guesses are right or wrong. There are no answer-specific replies or hints.

Five tries per mode per day. Progress, stats and streaks live in `localStorage`.

## Run

    ./serve.sh            # http://localhost:8772
    open http://localhost:8772/?day=2   # preview another day's number

## Puzzles

`tools/puzzles.src.json` holds the readable answers; `tools/build_puzzles.py`
writes `site/data/puzzles.json` with each answer base64-wrapped so a glance at
the network tab doesn't spoil it. Puzzle of the day = days since `epoch`,
cycling through each list.

    python3 -m venv .venv && .venv/bin/pip install numpy shapely networkx

    # Shape: Africa's coastline from Natural Earth
    curl -sSLo raw/geo/ne_50m_countries.geojson \
      https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson
    .venv/bin/python -I tools/make_africa.py raw/geo/ne_50m_countries.geojson site/data/draw/d001.json

    # Song: the chorus of Hips Don't Lie
    yt-dlp -f bestaudio -x --audio-format wav -o "raw/hips_dont_lie.%(ext)s" https://www.youtube.com/watch?v=DUT5rEU6pqM
    .venv/bin/python -I tools/make_song.py raw/hips_dont_lie.wav site/data/song/s001 \
      --start 18.9 --end 38.6 --errors 70,50,30,10,1

    .venv/bin/python -I tools/build_puzzles.py

A shape puzzle is any `{"points": [[x, y], ...]}` closed curve (screen
coordinates, y down), resampled evenly by arc length to a power of two (the
browser FFT needs it). Every picture needs inner detail, not just its outline.
`build_puzzles.py` turns the targets into term counts.

Song audio is derived from copyrighted recordings, so `raw/` and the
generated `*.mp3` files are gitignored (`viz.json` is only a coarse waveform
and spectrum summary). Rerun the commands above to rebuild them.
