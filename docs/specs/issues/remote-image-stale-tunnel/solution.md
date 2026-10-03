# Technical solution: Remote image stale tunnel

## Problem statement

See the [problem statement](problem.md). A server-side SSH session can keep the image listener after the local client loses its address. The helper reconnects, but the occupied port prevents a new reverse forward.

## Proposed solution

Configure OpenSSH server-side client liveness checks for the account used by the image tunnel. With `ClientAliveInterval 30` and `ClientAliveCountMax 3`, `sshd` terminates a client after unanswered protocol checks and releases its listeners. Allow 120 seconds for the recovery check rather than assuming an exact 90-second deadline.

The helper already uses client-side liveness checks and retries failed SSH commands. Server-side checks complete the recovery mechanism; additional helper retries or longer image-request timeouts cannot release a server-owned listener.

Apply the SSH configuration through a reload. Reloading preserves established sessions, but only new sessions use the new settings. Recreate the image tunnel after applying the configuration. A tunnel created before the reload can still require targeted cleanup.

The [remote image guide](../../../extensions/remote-image.md) contains configuration commands, effective-settings checks, recovery verification, and targeted cleanup instructions. The local installer continues to manage the local helper and startup service; the administrator configures the remote SSH server.

### Verification

Check that the tunnel account receives the intended settings and that other accounts retain their prior values. Temporarily pause only the local image-tunnel SSH process, observe the server releasing its listener, resume the process, and check that the helper restores image requests through a new server session. This check simulates an SSH client that stops responding without disabling the workstation's network.

On October 3, 2026, the affected server passed this live check. The old listener disappeared 115.4 seconds after the client was paused. After the client resumed, the helper created a new server session and the image endpoint returned HTTP 204 through the tunnel. HTTP 204 means the clipboard contained no image; the response proves the request reached the local helper again.

`sshd -t` passed. Effective settings for the tunnel account were `clientaliveinterval 30` and `clientalivecountmax 3`. The root account retained `clientaliveinterval 0`. The SSH service remained active after reload.

## Overengineering and overspecification considerations

Use OpenSSH's liveness mechanism rather than implementing remote process cleanup, port takeover, or another tunnel protocol in the helper. Limit the server configuration to the tunnel account. Its responsive interactive sessions remain connected.

## Open questions

None.

## References

- [Requirements](prd.md)
- [OpenSSH ClientAliveInterval](https://man.openbsd.org/sshd_config#ClientAliveInterval)
- [OpenSSH ClientAliveCountMax](https://man.openbsd.org/sshd_config#ClientAliveCountMax)
- `remote-image-helper/tunnel.go` defines client-side liveness settings and the reconnect loop.
