#!/usr/bin/env bash
# somora installer.
#
#   curl -fsSL https://somora.ai/install.sh | bash
#
# What it does, in order — every step is skipped when already in place:
#   1. system packages: tmux, ripgrep, git and a C/C++ toolchain
#   2. Node.js (>= 22.13) when missing or too old
#   3. an npm global folder inside your home directory
#   4. the somora package from npm
#   5. the background service (systemd user unit, survives logout)
#   6. `somora setup` — the guided first-run assistant
#
# Options (after `bash -s --`, or as environment variables):
#   --version <v>    install this somora version     SOMORA_VERSION=<v>
#   --yes            no questions, take the defaults SOMORA_YES=1
#   --no-setup       stop before the assistant       SOMORA_NO_SETUP=1
#   --no-service     do not register the service     SOMORA_NO_SERVICE=1
#   --no-sudo        never ask for admin rights      SOMORA_NO_SUDO=1
#
# Nothing here needs to run as root; admin rights are asked for only to
# install system packages, and only after showing what will be installed.

set -euo pipefail

NODE_MIN="22.13.0"
NODE_INSTALL_MAJOR="24"
PKG_NAME="somora"
LOCAL_NODE_DIR="$HOME/.local/share/somora/node"
NPM_PREFIX_DIR="$HOME/.npm-global"
PROFILE_MARK="# added by the somora installer"
# Dependencies that build or fetch a binary while installing. Newer npm
# versions want them named before they may do that (kept in step with
# src/cli/update-args.ts by a test).
ALLOW_SCRIPTS="better-sqlite3,cpu-features,esbuild,fsevents,node-pty,onnxruntime-node,protobufjs,ssh2"

VERSION="${SOMORA_VERSION:-latest}"
YES="${SOMORA_YES:-}"
NO_SETUP="${SOMORA_NO_SETUP:-}"
NO_SERVICE="${SOMORA_NO_SERVICE:-}"
NO_SUDO="${SOMORA_NO_SUDO:-}"

if [ -t 1 ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; RST=$'\033[0m'
else
  B=""; DIM=""; RED=""; GRN=""; YLW=""; RST=""
fi

step() { printf '\n%s==>%s %s%s%s\n' "$GRN" "$RST" "$B" "$*" "$RST"; }
info() { printf '    %s\n' "$*"; }
ok()   { printf '    %s✓%s %s\n' "$GRN" "$RST" "$*"; }
warn() { printf '    %s!%s %s\n' "$YLW" "$RST" "$*" >&2; }
die()  { printf '\n%serror:%s %s\n' "$RED" "$RST" "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# `curl … | bash` leaves stdin on the pipe, so questions are asked on the
# terminal itself. Without one (CI, ssh without -t) defaults apply.
HAVE_TTY=""
if [ -z "$YES" ] && [ -r /dev/tty ] && [ -w /dev/tty ] && (exec </dev/tty) 2>/dev/null; then
  HAVE_TTY=1
fi

# confirm "<question>" <default y|n>
confirm() {
  local q="$1" def="${2:-y}" hint="[Y/n]" ans=""
  [ "$def" = "n" ] && hint="[y/N]"
  if [ -z "$HAVE_TTY" ]; then
    [ "$def" = "y" ]; return
  fi
  printf '    %s %s ' "$q" "$hint" >/dev/tty
  read -r ans </dev/tty || ans=""
  ans="${ans:-$def}"
  case "$ans" in y|Y|yes|Yes|j|J|ja|Ja) return 0 ;; *) return 1 ;; esac
}

# version_ge <a> <b>  — true when a >= b (numeric, three parts)
version_ge() {
  local IFS=. a b i
  read -r -a a <<<"${1#v}"; read -r -a b <<<"${2#v}"
  for i in 0 1 2; do
    local x="${a[$i]:-0}" y="${b[$i]:-0}"
    x="${x%%[!0-9]*}"; y="${y%%[!0-9]*}"
    if [ "${x:-0}" -gt "${y:-0}" ]; then return 0; fi
    if [ "${x:-0}" -lt "${y:-0}" ]; then return 1; fi
  done
  return 0
}

usage() {
  cat <<'EOF'
somora installer

  curl -fsSL https://somora.ai/install.sh | bash
  curl -fsSL https://somora.ai/install.sh | bash -s -- --no-setup

Options:
  --version <v>    install this somora version     (SOMORA_VERSION)
  --yes            no questions, take the defaults (SOMORA_YES=1)
  --no-setup       stop before the assistant       (SOMORA_NO_SETUP=1)
  --no-service     do not register the service     (SOMORA_NO_SERVICE=1)
  --no-sudo        never ask for admin rights      (SOMORA_NO_SUDO=1)
EOF
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --version) [ $# -ge 2 ] || die "--version needs a value"; VERSION="$2"; shift 2 ;;
      --version=*) VERSION="${1#*=}"; shift ;;
      --yes|-y) YES=1; HAVE_TTY=""; shift ;;
      --no-setup) NO_SETUP=1; shift ;;
      --no-service) NO_SERVICE=1; shift ;;
      --no-sudo) NO_SUDO=1; shift ;;
      --help|-h) usage; exit 0 ;;
      *) die "unknown option: $1" ;;
    esac
  done
  VERSION="${VERSION#v}"
}

# ─── platform ─────────────────────────────────────────────────────────

OS=""; ARCH=""; PM=""; SUDO=""

detect_platform() {
  case "$(uname -s)" in
    Linux) OS="linux" ;;
    Darwin) OS="darwin" ;;
    *) die "somora runs on Linux and macOS. On Windows, install inside WSL2 and run this there." ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) ARCH="x64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) die "unsupported CPU: $(uname -m) (x86_64 and arm64 are supported)" ;;
  esac
  if [ "$(id -u)" = "0" ] && [ -z "${SOMORA_ALLOW_ROOT:-}" ]; then
    die "do not run this as root — somora runs as a normal user and its agents get that user's rights.
       Log in as the user who will own somora and run the same command again.
       (Override for containers: SOMORA_ALLOW_ROOT=1)"
  fi
  if [ "$OS" = "linux" ] && [ -f /etc/alpine-release ]; then
    die "Alpine (musl) is not supported — Node's native modules here need glibc. Use Debian, Ubuntu or Fedora."
  fi
  if have apt-get; then PM="apt"
  elif have dnf; then PM="dnf"
  elif have pacman; then PM="pacman"
  elif have zypper; then PM="zypper"
  elif have brew; then PM="brew"
  else PM=""
  fi
  if [ "$(id -u)" = "0" ]; then SUDO=""
  elif [ -n "$NO_SUDO" ]; then SUDO="none"
  elif have sudo; then SUDO="sudo"
  else SUDO="none"
  fi
  have curl || have wget || die "curl or wget is needed to download Node.js"
}

# Run a command with admin rights. Returns 1 when that is not possible.
as_root() {
  if [ "$(id -u)" = "0" ]; then "$@"; return; fi
  [ "$SUDO" = "sudo" ] || return 1
  if [ -n "$HAVE_TTY" ]; then sudo "$@" </dev/tty
  else sudo -n "$@"
  fi
}

can_sudo() {
  [ "$(id -u)" = "0" ] && return 0
  [ "$SUDO" = "sudo" ] || return 1
  [ -n "$HAVE_TTY" ] && return 0
  sudo -n true 2>/dev/null
}

# Run a noisy command quietly; show its last lines only when it fails.
quiet() {
  local log; log="$(mktemp)"
  if "$@" >"$log" 2>&1; then rm -f "$log"; return 0; fi
  tail -n 25 "$log" >&2; rm -f "$log"; return 1
}

fetch() { # fetch <url> <outfile>
  if have curl; then curl -fsSL "$1" -o "$2"; else wget -qO "$2" "$1"; fi
}

# ─── 1. system packages ───────────────────────────────────────────────

pkg_names() { # logical name → package name for $PM
  case "$PM:$1" in
    apt:cc) echo "build-essential" ;;
    dnf:cc|zypper:cc) echo "gcc-c++ make" ;;
    pacman:cc) echo "base-devel" ;;
    brew:cc) echo "" ;;
    *:rg) echo "ripgrep" ;;
    pacman:python3) echo "python" ;;
    brew:python3) echo "python" ;;
    apt:xz) echo "xz-utils" ;;
    *:xz) echo "xz" ;;
    *) echo "${1}" ;;
  esac
}

install_system_packages() {
  step "System packages"
  local missing=() need_cc=""
  have tmux || missing+=(tmux)
  have rg || missing+=(rg)
  have git || missing+=(git)
  if [ "$OS" = "linux" ]; then
    # node-pty has no prebuilt Linux binary — it is compiled on install.
    { have make && { have g++ || have c++; }; } || { missing+=(cc); need_cc=1; }
    have python3 || { missing+=(python3); need_cc=1; }
  else
    xcode-select -p >/dev/null 2>&1 || need_cc="xcode"
  fi

  if [ "${need_cc}" = "xcode" ]; then
    warn "Apple's command line tools are missing (needed to build one native module)."
    info "Run:  xcode-select --install   — then start this installer again."
    exit 1
  fi
  if [ ${#missing[@]} -eq 0 ]; then ok "tmux, ripgrep, git and the build tools are present"; return; fi

  local pkgs="" m
  for m in "${missing[@]}"; do pkgs="$pkgs $(pkg_names "$m")"; done
  local arr; read -r -a arr <<<"$pkgs"; pkgs="${arr[*]}"
  local cmd=""
  case "$PM" in
    apt) cmd="apt-get install -y $pkgs" ;;
    dnf) cmd="dnf install -y $pkgs" ;;
    pacman) cmd="pacman -S --needed --noconfirm $pkgs" ;;
    zypper) cmd="zypper --non-interactive install $pkgs" ;;
    brew) cmd="brew install $pkgs" ;;
  esac

  info "missing: ${missing[*]}"
  if [ -z "$cmd" ]; then
    [ -z "$need_cc" ] || die "no known package manager found. Install a C/C++ compiler, make and python3, then run this again."
    warn "no known package manager found — install these yourself later: $pkgs"
    return
  fi

  if [ "$PM" = "brew" ]; then
    info "installing with Homebrew: $pkgs"
    # shellcheck disable=SC2086
    quiet brew install $pkgs || warn "brew could not install everything — see the lines above"
  elif can_sudo && confirm "Install them with admin rights?  (sudo $cmd)" y; then
    info "installing: $pkgs"
    if [ "$PM" = "apt" ]; then quiet as_root env DEBIAN_FRONTEND=noninteractive apt-get update || true; fi
    # shellcheck disable=SC2086
    quiet as_root env DEBIAN_FRONTEND=noninteractive $cmd || die "package install failed — fix it and run this again:  sudo $cmd"
  elif [ -n "$need_cc" ]; then
    die "the build tools are required and need admin rights once. Ask an administrator to run:
         sudo $cmd
       then start this installer again."
  else
    warn "skipped. somora installs without them, but agents lose the matching tools."
    info "Later:  sudo $cmd"
    return
  fi
  ok "installed: $pkgs"
}

# ─── 2. Node.js ───────────────────────────────────────────────────────

node_ok() { have node && version_ge "$(node -v 2>/dev/null)" "$NODE_MIN"; }

sha256_of() {
  if have sha256sum; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# Official build from nodejs.org into the home directory — no admin
# rights, checksum-verified, and the service is told where it lives.
install_node_local() {
  local base="https://nodejs.org/dist/latest-v${NODE_INSTALL_MAJOR}.x" tmp file sum want
  have tar && have gzip || die "tar and gzip are needed to unpack Node.js — install them and run this again"
  tmp="$(mktemp -d)"
  fetch "$base/SHASUMS256.txt" "$tmp/SHASUMS256.txt" || die "could not reach nodejs.org"
  file="$(grep -o "node-v[0-9.]*-${OS}-${ARCH}\.tar\.gz" "$tmp/SHASUMS256.txt" | head -1)"
  [ -n "$file" ] || die "nodejs.org has no Node ${NODE_INSTALL_MAJOR} build for ${OS}-${ARCH}"
  info "downloading $file"
  fetch "$base/$file" "$tmp/$file" || die "download failed: $base/$file"
  want="$(grep " $file\$" "$tmp/SHASUMS256.txt" | cut -d' ' -f1)"
  sum="$(sha256_of "$tmp/$file")"
  [ "$want" = "$sum" ] || die "checksum mismatch for $file — not installing it"
  rm -rf "$LOCAL_NODE_DIR"; mkdir -p "$LOCAL_NODE_DIR"
  tar -xzf "$tmp/$file" -C "$LOCAL_NODE_DIR" --strip-components=1
  rm -rf "$tmp"
  export PATH="$LOCAL_NODE_DIR/bin:$PATH"
  add_to_path "$LOCAL_NODE_DIR/bin"
}

install_node_system() {
  case "$PM" in
    apt)
      fetch "https://deb.nodesource.com/setup_${NODE_INSTALL_MAJOR}.x" /tmp/somora-nodesource.sh || return 1
      as_root bash /tmp/somora-nodesource.sh >/dev/null || return 1
      quiet as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs || return 1 ;;
    dnf)
      fetch "https://rpm.nodesource.com/setup_${NODE_INSTALL_MAJOR}.x" /tmp/somora-nodesource.sh || return 1
      as_root bash /tmp/somora-nodesource.sh >/dev/null || return 1
      quiet as_root dnf install -y nodejs || return 1 ;;
    brew) brew install "node@${NODE_INSTALL_MAJOR}" && brew link --overwrite --force "node@${NODE_INSTALL_MAJOR}" || return 1 ;;
    *) return 1 ;;
  esac
  hash -r
  node_ok
}

install_node() {
  step "Node.js"
  # A Node from an earlier run of this installer is not on PATH in a
  # fresh shell until the profile is re-read.
  if ! node_ok && [ -x "$LOCAL_NODE_DIR/bin/node" ]; then export PATH="$LOCAL_NODE_DIR/bin:$PATH"; fi
  if node_ok; then ok "Node $(node -v) at $(command -v node)"; return; fi
  if have node; then info "found Node $(node -v) — somora needs $NODE_MIN or newer"
  else info "Node.js is not installed"
  fi

  local system_ok=""
  case "$PM" in apt|dnf) can_sudo && system_ok=1 ;; brew) system_ok=1 ;; esac
  [ -z "$system_ok" ] || info "installing Node ${NODE_INSTALL_MAJOR}…"
  if [ -n "$system_ok" ] && confirm "Install Node ${NODE_INSTALL_MAJOR} system-wide (NodeSource/Homebrew)?  No = into your home folder" y; then
    if install_node_system; then ok "Node $(node -v) installed system-wide"; return; fi
    warn "system-wide install did not work — using the home folder instead"
  fi
  install_node_local
  node_ok || die "Node install failed — install Node $NODE_MIN+ yourself (https://nodejs.org) and run this again"
  ok "Node $(node -v) installed in $LOCAL_NODE_DIR"
}

# ─── 3. npm global folder + PATH ──────────────────────────────────────

add_to_path() { # persist a PATH entry in the shell profiles
  local dir="$1" line f
  line="export PATH=\"$dir:\$PATH\"  $PROFILE_MARK"
  local files=("$HOME/.profile")
  [ -f "$HOME/.bashrc" ] && files+=("$HOME/.bashrc")
  [ -f "$HOME/.bash_profile" ] && files+=("$HOME/.bash_profile")
  { [ -f "$HOME/.zshrc" ] || [ "$(basename "${SHELL:-}")" = "zsh" ]; } && files+=("$HOME/.zshrc")
  for f in "${files[@]}"; do
    if ! grep -qsF "$dir" "$f"; then printf '\n%s\n' "$line" >>"$f"; fi
  done
}

setup_npm_prefix() {
  step "npm global folder"
  have npm || die "npm is missing although Node is installed — reinstall Node (https://nodejs.org)"
  local prefix
  prefix="$(npm config get prefix 2>/dev/null || true)"
  if [ -n "$prefix" ] && [ "$prefix" != "$LOCAL_NODE_DIR" ] && [ -w "$prefix" ] \
     && { [ ! -e "$prefix/lib/node_modules" ] || [ -w "$prefix/lib/node_modules" ]; }; then
    ok "npm installs into $prefix"
  else
    # Either root-owned (would need sudo on every update) or inside the
    # Node folder (would vanish with the next Node upgrade).
    mkdir -p "$NPM_PREFIX_DIR"
    npm config set prefix "$NPM_PREFIX_DIR"
    prefix="$NPM_PREFIX_DIR"
    ok "npm now installs into $prefix (no admin rights needed for updates)"
  fi
  case ":$PATH:" in *":$prefix/bin:"*) ;; *)
    export PATH="$prefix/bin:$PATH"
    add_to_path "$prefix/bin"
    PATH_CHANGED=1 ;;
  esac
}

# ─── 4. somora ────────────────────────────────────────────────────────

install_somora() {
  step "somora"
  local spec="$PKG_NAME@$VERSION" current=""
  if have somora; then current="$(somora --version 2>/dev/null || true)"; fi
  if [ -n "$current" ]; then info "installed: $current"; fi
  info "npm install -g $spec   (takes a few minutes, about 1.5 GB)"
  local allow=()
  # npm without the setting answers "undefined" — and would reject the flag.
  if [ "$(npm config get allow-scripts 2>/dev/null)" != "undefined" ]; then allow=("--allow-scripts=$ALLOW_SCRIPTS"); fi
  npm install -g --no-audit --no-fund --loglevel=error ${allow[@]+"${allow[@]}"} "$spec" \
    || die "npm could not install $spec. The lines above say why; after fixing it, run this installer again."
  hash -r
  have somora || die "somora was installed but is not on PATH ($(npm config get prefix)/bin)"
  ok "somora $(somora --version)"
}

# ─── 5. service ───────────────────────────────────────────────────────

SERVICE_OK=""
setup_service() {
  step "Background service"
  if [ -n "$NO_SERVICE" ]; then info "skipped (--no-service)"; somora init >/dev/null; return; fi
  if [ "$OS" = "darwin" ]; then
    somora init >/dev/null
    SERVICE_OK=1
    ok "registered (starts whenever you log in on this Mac)"
    info "A Mac used as a server: turn on automatic login, or somora waits for the first login after a reboot."
    return
  fi
  if [ "$OS" != "linux" ] || ! have systemctl || ! systemctl --user show-environment >/dev/null 2>&1; then
    somora init >/dev/null
    warn "no systemd user session here — somora cannot register a background service."
    info "Start it in a terminal (or tmux) when you need it:  somora server start --foreground"
    return
  fi
  somora init >/dev/null
  systemctl --user enable somora.service >/dev/null 2>&1 || true
  # Without lingering the service stops when you log out.
  local lingering=1
  if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" != "yes" ]; then
    loginctl enable-linger "$(id -un)" 2>/dev/null \
      || { can_sudo && as_root loginctl enable-linger "$(id -un)"; } \
      || lingering=""
  fi
  SERVICE_OK=1
  if [ -n "$lingering" ]; then
    ok "registered (starts at boot, keeps running after logout)"
  else
    ok "registered"
    warn "somora will stop when you log out, and not start at boot, until an administrator runs:"
    info "  sudo loginctl enable-linger $(id -un)"
  fi
}

# ─── 6. assistant ─────────────────────────────────────────────────────

finish() {
  if [ -z "$NO_SETUP" ] && [ -n "$HAVE_TTY" ]; then
    step "Setup assistant"
    somora setup </dev/tty || warn "the assistant stopped early — run it again any time:  somora setup"
  else
    if [ -n "$SERVICE_OK" ]; then somora server start >/dev/null 2>&1 || true; fi
    step "Installed"
    info "Next:  ${B}somora setup${RST}   — the guided assistant (models, first agent, memory, HTTPS)"
  fi
  if [ -n "${PATH_CHANGED:-}" ]; then
    printf '\n    %sOpen a new terminal (or run: source ~/.profile) so the `somora` command is found.%s\n' "$YLW" "$RST"
  fi
  printf '\n    Docs: https://github.com/thenaxon/somora_agent#readme   Update later: somora update\n\n'
}

main() {
  parse_args "$@"
  printf '%ssomora installer%s  %s(%s)%s\n' "$B" "$RST" "$DIM" "$VERSION" "$RST"
  detect_platform
  install_system_packages
  install_node
  setup_npm_prefix
  install_somora
  setup_service
  finish
}

# Wrapped in a function and called on the last line, so a download that
# breaks off halfway runs nothing at all.
main "$@"
