# Problem statement

## Context

`remote-image` transfers clipboard images from a local helper through an SSH reverse tunnel. The remote server uses a fixed loopback port for image requests.

## Observed problem

After a client network interruption, the remote SSH session can retain the image port and prevent the helper from restoring image transfer.

## Affected audience

Users who paste images into remote pi after their local computer loses and restores network access.

## Evidence

On October 3, 2026, macOS removed the client's `10.222.2.5` address at 11:58:29 +03:00 after DHCP timed out. The helper's SSH client exited at 11:58:55 with `Can't assign requested address` and `Broken pipe`.

macOS restored the address at 11:59:37. From 11:59:38, the SSH server at `10.222.2.21` rejected new reverse forwards with `bind [127.0.0.1]:18775: Address already in use`. The port belonged to the old `sshd-session`, whose TCP connection no longer received acknowledgements.

The server's effective `ClientAliveInterval` was `0`. A direct request to the local helper returned HTTP 204 in 3 milliseconds, while requests through the stale tunnel received no response. Evidence came from the macOS `configd` log, the helper runtime log, the server SSH journal, `ss`, `sshd -T`, and HTTP requests.

## Impact

Image paste fails even after network access returns. The helper repeatedly attempts to reconnect, but the old server session blocks its fixed port.

## Current state

On servers with SSH client liveness checks disabled, the server relies on TCP failure detection to reclaim an interrupted tunnel. Client-side SSH liveness checks do not terminate the old server session.

## Desired state

After network access returns, users can resume image paste without manually identifying and terminating a stale server session.

## Problem boundary

The problem is the prolonged image-transfer outage caused by an old reverse-forward listener. The initial loss of DHCP service is a separate network problem.

## Open questions

None for the stale-tunnel recovery failure. The reason for the initial DHCP interruption is outside this issue.
