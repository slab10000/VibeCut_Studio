#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VENV_DIR="${VIBECUT_SIDECAR_VENV:-$ROOT_DIR/.venv-sidecar}"
PYTHON_BIN="$VENV_DIR/bin/python"

if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "[vibecut] Creating isolated sidecar environment..."
  python3 -m venv "$VENV_DIR"
fi

if ! "$PYTHON_BIN" - <<'PY'
import importlib.util
import sys

required = ("fastapi", "uvicorn", "whisperx")
missing = [name for name in required if importlib.util.find_spec(name) is None]

if missing:
    print(",".join(missing))
    sys.exit(1)
PY
then
  echo "[vibecut] Installing missing sidecar dependencies..."
  "$PYTHON_BIN" -m pip install -r sidecar/requirements.txt
fi

if [[ "${1:-}" == "--install-only" ]]; then
  exit 0
fi

exec "$PYTHON_BIN" -m uvicorn sidecar.server:app --host 127.0.0.1 --port 8765
