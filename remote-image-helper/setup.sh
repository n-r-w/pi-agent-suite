#!/bin/sh
set -eu

repository="n-r-w/pi-agent-suite"
version="${PI_AGENT_SUITE_VERSION:-latest}"
target="${1:-${PI_AGENT_SUITE_SSH_TARGET:-}}"
port="${PI_AGENT_SUITE_IMAGE_PORT:-18775}"

if [ -z "$target" ]; then
	echo "Usage: PI_AGENT_SUITE_SSH_PASSWORD=optional $0 <ssh-target>" >&2
	exit 1
fi

case "$(uname -s)" in
	Darwin) operating_system="darwin" ;;
	Linux) operating_system="linux" ;;
	*) echo "Unsupported operating system: $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
	x86_64|amd64) architecture="amd64" ;;
	arm64|aarch64) architecture="arm64" ;;
	*) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

asset="pi-agent-suite-remote-image-${operating_system}-${architecture}"
if [ "$version" = "latest" ]; then
	url="https://github.com/${repository}/releases/latest/download/${asset}"
else
	case "$version" in v*) tag="$version" ;; *) tag="v$version" ;; esac
	url="https://github.com/${repository}/releases/download/${tag}/${asset}"
fi

temporary_directory="$(mktemp -d)"
trap 'rm -rf "$temporary_directory"' EXIT HUP INT TERM
helper="$temporary_directory/$asset"
curl -fL "$url" -o "$helper"
chmod 700 "$helper"

PI_AGENT_SUITE_SSH_TARGET="$target" \
PI_AGENT_SUITE_SSH_PASSWORD="${PI_AGENT_SUITE_SSH_PASSWORD:-}" \
PI_AGENT_SUITE_IMAGE_PORT="$port" \
	"$helper" install
