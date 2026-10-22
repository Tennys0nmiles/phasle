# Phasle

A daily guessing game in the style of Wordle/Heardle, built on Fourier series.

- **Shape**: a picture drawn with one closed line is rebuilt from its biggest
  Fourier terms (spinning circles, i.e. epicycles). Each guess or skip adds
  circles: 2 → 3 → 5 → 8 → 12 → 20. The % error is the share of the curve's
  energy that the missing terms carry (Parseval).
- **Song**: each STFT frame keeps only its N loudest sine waves (A-weighted
  ranking, Hann main lobe kept so pitches stay true): 2 → 4 → 8 → 16 → 32 → 64.
  The % error is the relative L2 error of the waveform.

Six tries per mode per day. Progress, stats and streaks live in `localStorage`.

## Run

    ./serve.sh            # http://localhost:8772
    open http://localhost:8772/?day=2   # preview another day's number

## Puzzles

`tools/puzzles.src.json` holds the readable answers; `tools/build_puzzles.py`
writes `site/data/puzzles.json` with each answer base64-wrapped so a glance at
the network tab doesn't spoil it. Puzzle of the day = days since `epoch`,
cycling through each list.

    python3 -m venv .venv && .venv/bin/pip install numpy scipy shapely

    # Shape: Africa's coastline from Natural Earth
    curl -sSLo raw/geo/ne_50m_countries.geojson \
      https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson
    .venv/bin/python -I tools/make_africa.py raw/geo/ne_50m_countries.geojson site/data/draw/d001.json

    # Song: the chorus of Hips Don't Lie
    yt-dlp -f bestaudio -x --audio-format wav -o "raw/hips_dont_lie.%(ext)s" https://www.youtube.com/watch?v=DUT5rEU6pqM
    .venv/bin/python -I tools/make_song.py raw/hips_dont_lie.wav site/data/song/s001 \
      --start 18.9 --end 38.6 --tiers 2,4,8,16,32,64

    .venv/bin/python -I tools/build_puzzles.py

A shape puzzle is any `{"points": [[x, y], ...]}` closed curve (screen
coordinates, y down), ideally resampled evenly by arc length. 1024 points is
plenty.

Song audio and the per-frame peak data are derived from copyrighted
recordings, so `raw/` and the generated `*.mp3` / `peaks.bin` files are
gitignored. Rerun the commands above to rebuild them.
