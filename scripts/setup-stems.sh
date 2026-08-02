#!/usr/bin/env bash
#
# One-time setup for local stem separation (Demucs).
#
# Demucs needs PyTorch, which has no wheels for the system's Python 3.14 yet, so
# this creates a dedicated Python 3.12 venv with `uv` and installs Demucs into
# it. On Apple Silicon, PyTorch ships with the MPS (Metal) backend, so
# separations run on the GPU. This is local-only — the hosted deploy never runs it.
#
# Usage:  bash scripts/setup-stems.sh
# Then:   npm run power   (picks up MURDOCK_DEMUCS_VENV from .env.local)

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
VENV="$ROOT/.venv-demucs"
PYVER="3.12"

echo "murdock · stem setup"
echo "  root: $ROOT"

# 1. Ensure uv (fast Python env manager) is available.
if ! command -v uv >/dev/null 2>&1; then
  echo "  installing uv…"
  if command -v brew >/dev/null 2>&1; then
    brew install uv
  else
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"
  fi
fi
echo "  uv: $(command -v uv)"

# 2. Create the pinned-Python venv (uv fetches CPython 3.12 if needed).
if [ ! -x "$VENV/bin/demucs" ]; then
  echo "  creating venv ($PYVER) at .venv-demucs …"
  uv venv --python "$PYVER" "$VENV"

  echo "  installing demucs + torch (this downloads ~2GB, one time)…"
  # numpy + torchaudio + soundfile are runtime deps Demucs 4.1 needs but doesn't
  # always pull in on its own; pin them explicitly so the install is complete.
  uv pip install --python "$VENV/bin/python" demucs numpy torchaudio soundfile
else
  echo "  demucs already installed in .venv-demucs"
fi

# 3. Record the venv path for the power run profile.
ENVLOCAL="$ROOT/.env.local"
touch "$ENVLOCAL"
if ! grep -q '^MURDOCK_DEMUCS_VENV=' "$ENVLOCAL" 2>/dev/null; then
  echo "MURDOCK_DEMUCS_VENV=$VENV" >> "$ENVLOCAL"
  echo "  wrote MURDOCK_DEMUCS_VENV to .env.local"
fi

echo
echo "  ✓ stems ready. Verifying…"
"$VENV/bin/demucs" --help >/dev/null 2>&1 && echo "  ✓ demucs runs" || { echo "  ✗ demucs failed to run"; exit 1; }
echo
echo "Done. Restart murdock with:  npm run power"
