# Idea: Remote image recovery after a stale tunnel

## Definitions

See [terms](terms.md).

## Context and problem

See the [problem statement](problem.md). An interrupted client connection can leave the server's image port occupied and prevent reconnection.

## Goal

Restore image transfer after client network interruptions without manual server-session cleanup.

## Scenarios

- A local computer loses its network address while its image tunnel is established.
- Network access returns, and the helper attempts to recreate the reverse tunnel.
- An administrator prepares a remote server for image paste.

## Scope and non-scope

Scope includes SSH server liveness configuration, remote setup instructions, targeted stale-session recovery instructions, and a live recovery check on the affected server.

Changes to image acquisition, extension request timeouts, the macOS installer, and DHCP configuration are outside scope.

## Requirements

### Functional requirements

- [x] FRQ-01: Remote setup instructions SHALL describe the server configuration and effective-settings check needed to release an unresponsive image tunnel.
  - Origin: source; user approved documentation and server configuration work.
  - Goal: Prevent omission of the server-side recovery prerequisite.
  - Goal achievement: Partial. Instructions enable administrators to prepare each server; instructions alone do not configure it.
- [x] FRQ-02: The affected server SHALL release an unresponsive tunnel's image listener, and the helper SHALL restore image requests after its SSH client resumes.
  - Origin: source; user approved configuration and recovery verification on the affected server.
  - Goal: Remove the stale listener that blocks reconnection.
  - Goal achievement: Full for the observed failure mechanism.

### Non-functional requirements

- [x] NRQ-01: Applying the configuration and performing the recovery check SHALL preserve unrelated SSH sessions.
  - Origin: source; the approved procedure targets image transfer without stopping ordinary SSH sessions.
  - Goal: Keep administrative and interactive access available.
  - Goal achievement: Full for access continuity during this change.

## Open questions

None.

## References

- [Remote image guide](../../../extensions/remote-image.md)
- [Technical solution](solution.md)
