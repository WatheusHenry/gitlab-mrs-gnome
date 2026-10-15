#!/usr/bin/env bash
# Removes GitLab MRs for the current user. Settings and the Geist fonts are kept
# (the paths are printed so they can be removed by hand).
set -euo pipefail

UUID="gitlab-mrs@matheus.sanches"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
DEST="$DATA/gnome-shell/extensions/$UUID"

gnome-extensions disable "$UUID" >/dev/null 2>&1 || true
enabled="$(gsettings get org.gnome.shell enabled-extensions)"
cleaned="$(printf '%s' "$enabled" | sed -E "s/, '$UUID'|'$UUID', |'$UUID'//")"
[ "$cleaned" = "[]" ] && cleaned="@as []"
gsettings set org.gnome.shell enabled-extensions "$cleaned"

rm -rf "$DEST"
echo "Extensão removida de $DEST"
echo "Mantidos (apague se quiser):"
echo "  Configuração e token: ${XDG_CONFIG_HOME:-$HOME/.config}/gitlab-mrs/"
echo "  Fontes Geist:         $DATA/fonts/Geist/"
echo "Saia e entre na sessão para o ícone sumir da barra."
