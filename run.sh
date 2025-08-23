#!/usr/bin/env bash
# Node v20 (nvm) + .venv を有効化して Discord Recorder を起動
# 使い方:
#   chmod +x run.sh
#   ./run.sh            # 起動
#   ./run.sh --install  # 依存を自動インストール（npm/pip install -r requirements.txt）

set -euo pipefail

NODE_VERSION="${NODE_VERSION:-20}"
DO_INSTALL=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --install) DO_INSTALL=1; shift ;;
    *) echo "Unknown option: $1"; exit 2 ;;
  esac
done

# --- 1) nvm 読み込み & Node v20
load_nvm() {
  if [[ -n "${NVM_DIR:-}" && -s "$NVM_DIR/nvm.sh" ]]; then
    # shellcheck disable=SC1090
    source "$NVM_DIR/nvm.sh"; return
  fi
  for CAND in "$HOME/.nvm/nvm.sh" "/opt/homebrew/opt/nvm/nvm.sh" "/usr/local/opt/nvm/nvm.sh"; do
    [[ -s "$CAND" ]] && { source "$CAND"; return; }
  done
  echo "ERROR: nvm が見つかりません。https://github.com/nvm-sh/nvm を参照して導入してください。"; exit 1
}
load_nvm
nvm install "$NODE_VERSION" >/dev/null
nvm use "$NODE_VERSION"
echo "[Node] $(node -v) via nvm"

# --- 2) .venv を有効化（stt.py は Node から execFile('python3') で呼ばれる）
if [[ ! -f ".venv/bin/activate" ]]; then
  echo "ERROR: .venv がありません。例: python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt"
  exit 1
fi
# shellcheck disable=SC1091
source .venv/bin/activate
echo "[Python] $(python -V) in .venv"

# --- 3) ffprobe 確認（index.js は ffprobe を使用）
if ! command -v ffprobe >/dev/null 2>&1; then
  echo "ERROR: ffprobe が未インストールです（ffmpeg に同梱）。例: brew install ffmpeg"
  exit 1
fi

# --- 4) 依存インストール（任意）
if [[ $DO_INSTALL -eq 1 ]]; then
  if [[ -f package.json ]]; then
    if command -v pnpm >/dev/null 2>&1 && [[ -f pnpm-lock.yaml ]]; then pnpm install
    elif command -v yarn >/dev/null 2>&1 && [[ -f yarn.lock ]]; then yarn install
    else npm ci || npm install
    fi
  fi
  [[ -f requirements.txt ]] && pip install -r requirements.txt
fi

# --- 5) 起動（package.json の scripts.start = "node index.js"）
export PATH="$PATH"  # 明示（.venv の python3 を PATH に残すため）
npm start
