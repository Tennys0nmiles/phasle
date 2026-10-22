#!/usr/bin/env bash
# Serve the static site at http://localhost:8772
cd "$(dirname "$0")/site" && exec python3 -m http.server "${PORT:-8772}" --bind 127.0.0.1
