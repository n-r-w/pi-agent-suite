# remote-image

## Purpose

`remote-image` transfers an image from the local clipboard to pi on a remote Linux server. Press `Ctrl+V` in remote pi. The extension requests PNG bytes through an SSH reverse tunnel, saves a temporary PNG on the server, and inserts its server path into the editor.

The local computer runs the standalone helper. A local pi process and a local Node.js runtime are not required.

## Requirements

- Local computer: macOS, Linux desktop, or Windows.
- Remote server: Linux with pi-agent-suite installed.
- Local and remote systems: OpenSSH.
- SSH server: loopback reverse forwarding must be permitted.
- Linux local computer: an X11 session, or a Wayland compositor with data-control support or XWayland.

## Local setup

Download the setup script from the same GitHub release as the helper.

### macOS or Linux

```bash
curl -fLO https://github.com/n-r-w/pi-agent-suite/releases/latest/download/setup-remote-image.sh
chmod 700 setup-remote-image.sh
./setup-remote-image.sh user@server.example
```

For SSH password authentication:

```bash
PI_AGENT_SUITE_SSH_PASSWORD='your-password' ./setup-remote-image.sh user@server.example
```

### Windows PowerShell

```powershell
Invoke-WebRequest https://github.com/n-r-w/pi-agent-suite/releases/latest/download/setup-remote-image.ps1 -OutFile setup-remote-image.ps1
.\setup-remote-image.ps1 -SshTarget user@server.example
```

For SSH password authentication:

```powershell
.\setup-remote-image.ps1 -SshTarget user@server.example -SshPassword 'your-password'
```

The setup installs the helper for the current user, saves the connection settings, starts the helper, and configures startup after graphical login. The saved password is stored as plain text in the current user's configuration file. Without a saved password, OpenSSH uses its configured key, agent, and host settings.

The first connection can require normal OpenSSH host-key confirmation. Run `ssh user@server.example` once before setup when the host key has not been accepted.

## Remote setup

Set these variables in the environment that starts pi:

```bash
export PI_AGENT_SUITE_MODE=remote
export PI_AGENT_SUITE_IMAGE_PORT=18775
```

`PI_AGENT_SUITE_IMAGE_PORT` is optional. Its default is `18775`. If another value is used, pass the same value to local setup:

```bash
PI_AGENT_SUITE_IMAGE_PORT=19000 ./setup-remote-image.sh user@server.example
```

Restart pi after changing the environment. The extension registers `Ctrl+V` only when `PI_AGENT_SUITE_MODE` is `remote`. Pi can report its normal shortcut-conflict warning because this extension replaces native clipboard image paste in remote mode.

## Operation

1. Copy an image or take a screenshot on the local computer.
2. Press `Ctrl+V` in remote pi.
3. Wait for the server path to appear in the editor.
4. Submit the prompt when ready.

An empty image clipboard produces a warning and inserts no text. A tunnel, HTTP, or file error produces an error notification and inserts no path.

## Configuration

| Variable | Location | Default | Meaning |
| --- | --- | --- | --- |
| `PI_AGENT_SUITE_SSH_TARGET` | Local setup | None | OpenSSH destination or SSH config alias. Required. |
| `PI_AGENT_SUITE_SSH_PASSWORD` | Local setup | None | Optional SSH account password. |
| `PI_AGENT_SUITE_IMAGE_PORT` | Local setup and remote pi | `18775` | Loopback image transfer port. |
| `PI_AGENT_SUITE_MODE` | Remote pi | None | `remote` enables the extension. |
| `PI_AGENT_SUITE_VERSION` | macOS or Linux setup | `latest` | Helper release version. Accepts `2.9.1` or `v2.9.1`. |

The helper binds `127.0.0.1` only. OpenSSH forwards the same loopback port to the remote server. The feature does not open an externally reachable listener and adds no protocol above SSH.

## Troubleshooting

- `connection refused`: check that the helper is running and that the local and remote port values match.
- `remote port forwarding failed`: check that the remote port is unused and the SSH server permits loopback reverse forwarding.
- Repeated SSH authentication failures: run the same SSH target with the system `ssh` command. Check the host key and authentication settings.
- Empty clipboard warning with an image copied on Linux: check the desktop session. Wayland requires data-control support or XWayland.
