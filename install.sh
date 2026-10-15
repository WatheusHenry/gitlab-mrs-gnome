#!/usr/bin/env bash
# Installs GitLab MRs for the current user: extension files, Geist fonts, and enables it.
# Run from a clone of the repository or from an extracted release zip.
set -euo pipefail

UUID="gitlab-mrs@matheus.sanches"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
DEST="$DATA/gnome-shell/extensions/$UUID"
FONTS="$DATA/fonts/Geist"

say() { printf '\033[1m%s\033[0m\n' "$*"; }

if ! command -v gnome-shell >/dev/null; then
    echo "GNOME Shell não encontrado. Esta extensão só funciona no GNOME." >&2
    exit 1
fi
shell_version="$(gnome-shell --version | grep -oE '[0-9]+' | head -1)"
if [ "$shell_version" != "42" ]; then
    say "Aviso: testada só no GNOME Shell 42 (você tem o $shell_version). Pode não carregar."
fi

say "Instalando a extensão em $DEST"
if [ "$(realpath -m "$SRC")" != "$(realpath -m "$DEST")" ]; then
    rm -rf "$DEST"
    mkdir -p "$DEST"
    cp -r "$SRC"/metadata.json "$SRC"/extension.js "$SRC"/api.js "$SRC"/stylesheet.css "$SRC"/icons "$DEST"/
fi

say "Instalando as fontes Geist e Geist Mono em $FONTS"
mkdir -p "$FONTS"
cp "$SRC"/fonts/*.otf "$SRC"/fonts/OFL.txt "$FONTS"/
fc-cache -f "$FONTS" >/dev/null 2>&1 || true

say "Ativando a extensão"
# A freshly copied extension is unknown to the running shell, so `gnome-extensions enable`
# fails until the next login; adding the uuid to the setting works either way.
if ! gnome-extensions enable "$UUID" >/dev/null 2>&1; then
    enabled="$(gsettings get org.gnome.shell enabled-extensions)"
    case "$enabled" in
        *"'$UUID'"*) ;;
        "@as []"|"[]") gsettings set org.gnome.shell enabled-extensions "['$UUID']" ;;
        *) gsettings set org.gnome.shell enabled-extensions "${enabled%]}, '$UUID']" ;;
    esac
fi
if [ "$(gsettings get org.gnome.shell disable-user-extensions)" = "true" ]; then
    say "Aviso: as extensões de usuário estão desativadas no sistema."
    echo "  Ative com: gsettings set org.gnome.shell disable-user-extensions false"
fi

echo
say "Pronto! Para carregar a extensão:"
if [ "${XDG_SESSION_TYPE:-}" = "x11" ]; then
    echo "  Pressione Alt+F2, digite r e Enter (reinicia o GNOME Shell)."
else
    echo "  Saia da sessão e entre de novo (no Wayland o GNOME Shell não reinicia sozinho)."
fi
echo "  Depois clique no ícone de merge request na barra superior e abra as Configurações."
