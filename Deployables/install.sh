#!/usr/bin/env bash
# Nomyx agent installer (Linux, systemd). Run from the folder containing the
# unpacked agent binaries, your config.json, and nomyx-agent.service.
set -e

DEST=/opt/nomyx-agent

# Pick the right binary for this machine's architecture.
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)        BIN=nomyx-agent-linux-x64   ;;
  aarch64|arm64) BIN=nomyx-agent-linux-arm64 ;;   # Raspberry Pi 64-bit
  *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

if [ ! -f "$BIN" ]; then
  echo "Binary $BIN not found in this folder."; exit 1
fi
if [ ! -f config.json ]; then
  echo "config.json not found in this folder — create one first."; exit 1
fi

echo "Installing Nomyx agent ($BIN) to $DEST"
sudo mkdir -p "$DEST"
sudo cp "$BIN" "$DEST/nomyx-agent"
sudo chmod +x "$DEST/nomyx-agent"
sudo cp config.json "$DEST/config.json"
sudo cp nomyx-agent.service /etc/systemd/system/nomyx-agent.service

sudo systemctl daemon-reload
sudo systemctl enable --now nomyx-agent

echo
echo "Installed and started. Check it with:"
echo "  sudo systemctl status nomyx-agent"
echo "  journalctl -u nomyx-agent -f"
