# Terms

- Reverse tunnel: an SSH connection that forwards the remote server's loopback image port to the local helper.
- Stale tunnel: a server-side SSH session that retains its reverse-forward listener after the client connection has become unusable.
- Server-side client liveness check: an SSH protocol request that allows `sshd` to terminate a client that does not respond within its configured threshold.
