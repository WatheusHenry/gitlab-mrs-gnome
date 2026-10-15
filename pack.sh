#!/usr/bin/env bash
# Builds dist/gitlab-mrs@matheus.sanches.shell-extension.zip: the extension plus fonts,
# install/uninstall scripts and docs, so the zip alone is enough to install.
# Plain zip because `gnome-extensions pack` segfaults on GNOME 42; the layout is the
# same (metadata.json at the root), so `gnome-extensions install <zip>` also works.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
UUID="$(sed -nE 's/.*"uuid": *"([^"]+)".*/\1/p' metadata.json)"
OUT="dist/$UUID.shell-extension.zip"
mkdir -p dist
rm -f "$OUT"
zip -qr "$OUT" metadata.json extension.js api.js stylesheet.css icons fonts \
    install.sh uninstall.sh README.md LICENSE
ls -lh "$OUT"
