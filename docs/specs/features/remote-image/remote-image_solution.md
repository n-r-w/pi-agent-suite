# Technical solution: Remote image paste

## Problem statement

See the [problem statement](remote-image_problem.md), [domain glossary](domain-glossary.md), and approved [requirements](remote-image_prd.md).

## Proposed solution

### Components and distribution

- Add a standalone Go local helper in this repository. Use `golang.design/x/clipboard` v0.9.0 for image acquisition and the system OpenSSH client for the tunnel. Go is a build dependency, not a workstation prerequisite.
- Configure automatic helper startup in the user's graphical session. A machine-level service cannot be assumed to have access to that user's clipboard.
- Add a TypeScript remote image extension to the pi package. The remote server runs pi; the local computer does not.
- Distribute prebuilt helper binaries and setup scripts for macOS, Linux, and Windows. The user runs the setup script for each SSH target. Ordinary SSH terminal connections remain independent of the helper.

### Persistent setup and startup

- The setup script stores a list of SSH target settings, including each optional SSH password, in one local configuration file. Adding an SSH target appends it to the list. Adding an exact existing target replaces that target's settings and preserves other targets. The old single-target configuration format is migrated when setup next writes the file. There is no separate encrypted credential store.
- Use a user LaunchAgent on macOS, a systemd user service bound to `graphical-session.target` on Linux, and an interactive-user logon task on Windows. The helper runs in the graphical session that owns the clipboard, not Windows Session 0.
- Reinstallation stops the old helper before replacing its executable or configuration. On macOS, wait for LaunchAgent removal after `bootout`. On Linux, synchronous `systemctl --user stop` stops the service control group, including SSH. On Windows, disable the old task, terminate the helper process tree, and wait for the task and tracked processes to exit. A stop failure aborts replacement.
- Runtime and SSH diagnostics go to the systemd user journal on Linux and a file next to the configuration on macOS and Windows. Setup prints the diagnostic location. Successful service registration does not confirm SSH connectivity.
- Initial SSH host-key confirmation remains part of normal setup. The helper uses OpenSSH authentication and host-key handling rather than adding a separate trust or authentication mechanism.
- The setup removal command matches the exact SSH target string. When targets remain, setup restarts the helper with those targets. Removing the final target stops the helper and deletes its configuration, runtime diagnostics file, executable, and platform autostart registration.
- The remote image extension is enabled through `PI_AGENT_SUITE_MODE=remote`. Each SSH target setting and its remote image extension use the same image transfer port.

### Configuration

| Setting | Location | Meaning |
| --- | --- | --- |
| `PI_AGENT_SUITE_SSH_TARGET` | Local setup | Required SSH target and identity for one saved target setting. |
| `PI_AGENT_SUITE_SSH_PASSWORD` | Local setup | Optional SSH password. Without it, use the user's configured SSH authentication. |
| `PI_AGENT_SUITE_IMAGE_PORT` | Local setup and remote pi | Image transfer port. Default `18775`. |
| `PI_AGENT_SUITE_MODE` | Remote pi | Set to `remote` to enable the remote image extension. |

The SSH server port comes from OpenSSH configuration and defaults. The helper has no separate SSH port setting. The installer persists local setup values so the user does not need to export them again for each login.

### SSH and password handling

- The local helper starts one system OpenSSH client per configured SSH target with a loopback-to-loopback reverse TCP forward. The helper maintains these connections independently of interactive terminal connections and reconnects each tunnel after network loss.
- The local helper binds one HTTP listener to `127.0.0.1` using the first configured target's image transfer port. Each reverse forward binds its target's configured loopback port on the remote server and forwards requests to the one local listener.
- The server must permit loopback-only reverse forwarding. The setup scripts do not change `sshd` configuration automatically. This topology adds no ports for external connections.
- With a configured password, OpenSSH uses `SSH_ASKPASS` to invoke the same helper executable in a password-response mode. The SSH tunnel identifies its exact target, and this mode returns only that target's configured password rather than starting another listener or tunnel. No separate askpass application is installed. Select SSH password-capable authentication methods in this mode so the saved account password does not answer a private-key passphrase prompt.
- Without a configured password, OpenSSH uses the user's configured authentication. The helper does not implement a second SSH client or a custom authentication protocol.

### Image request and editor behavior

- Read the local clipboard only in response to an image request. Do not monitor or synchronize clipboard changes continuously.
- Use one HTTP image request through the SSH tunnel. A successful response contains PNG bytes from `golang.design/x/clipboard`. Do not add TLS, tokens, or authentication above SSH.

```text
Ctrl+V in remote pi
    -> remote image extension requests an image through the SSH tunnel
    -> local helper reads the local clipboard
    -> remote image extension receives PNG bytes
    -> remote image extension saves a temporary file on the remote server
    -> ctx.ui.pasteToEditor(serverPath) inserts the server path
```

- An empty clipboard or a transfer failure produces a notification in pi and no inserted path. The extension inserts a server path only after the image has been saved. Pasting does not submit a message to the model.
- The extension uses pi's editor API. It does not simulate keyboard input or replace the terminal UI.
- Existing image tools can read the server file through their file-path interface. The feature does not require changing `describe_image`.

### Platform evidence and verification

- Installed pi 0.85.1 checks extension shortcuts before native image paste. It permits the Ctrl+V override and reports its standard shortcut-conflict warning. No pi patch or custom editor is needed.
- The selected clipboard library documents native desktop image reads without `pngpaste`, `xclip`, `wl-paste`, or a Node.js runtime. Its Linux initialization selects Wayland with data-control support, otherwise X11. Linux desktop compatibility must be checked with real image paste during implementation.
- The Windows OpenSSH source contains `SSH_ASKPASS` process invocation and `SSH_ASKPASS_REQUIRE=force` handling. This is source evidence, not an end-to-end check of the helper on Windows.
- Linux requires a desktop session that activates `graphical-session.target` in the systemd user manager. Setup imports the available graphical-session environment variables. The service starts with the graphical session and stops with it. The Windows logon task runs as the interactive user. Neither uses a machine-level service for clipboard access.
- Implementation verification must cover request-to-file-to-editor behavior with isolated fakes, SSH process lifecycle and password-response behavior with fake processes, and extension loading through the real pi CLI. Live platform checks must cover native clipboard access, SSH authentication, graphical-session startup, and reconnection. No live platform check has been performed for this feature.

## Overengineering and overspecification considerations

The runtime consists of one local helper, one system OpenSSH process per SSH target, and one pi extension on each remote server. Setup scripts provide persistent configuration without requiring a replacement SSH command or local pi process. Clipboard and SSH implementations come from existing libraries and tools, not new protocol implementations.

There is no added security layer, token service, encrypted credential store, continuous clipboard synchronization, or custom terminal UI. The image transfer uses one request through SSH. Reverse image transfer is outside scope.

## Open questions

None. The dry-run found no material unresolved implementation choice. Native builds and live platform checks remain implementation verification work; their results are not established by this design.

## References

- [Requirements](remote-image_prd.md) define the approved behavior and constraints.
- [Vision extension](../../../extensions/vision.md) documents the existing image-path consumer.
- [Clipboard library v0.9.0](https://github.com/golang-design/clipboard/tree/v0.9.0) documents the selected native clipboard implementation and platform constraints.
- [Windows OpenSSH password handling](https://github.com/PowerShell/openssh-portable/blob/latestw_all/readpass.c) implements askpass invocation on Windows.
- [OpenSSH remote forwarding](https://man.openbsd.org/ssh_config#RemoteForward) describes the tunnel mechanism.
- [systemd graphical-session.target](https://www.freedesktop.org/software/systemd/man/latest/systemd.special.html#graphical-session.target) defines the Linux graphical user session lifecycle.
- [Yandex MCP workstation setup](https://github.com/n-r-w/yandex-mcp#workstation-setup) provides the reference idea of one-time setup and persistent local operation.
