# Idea: Remote image paste

## Definitions

Use the [domain glossary](domain-glossary.md).

## Context and problem

See the [problem statement](remote-image_problem.md).

## Goal

Make local images available to remote pi without manual file copying or path correction, with simple setup and daily use.

## Scenarios

The user connects to one or more remote servers through SSH, starts pi on those servers, and pastes an image from the local computer.

## Scope and non-scope

The feature covers image transfer from the local computer to remote pi. Transfer in the opposite direction is outside scope.

Prefer the fewest installed components and the least initial configuration. A local helper is acceptable. Operation without additional applications is a preference, not an established technical capability.

## Requirements

### Functional requirements

- FRQ-01: Pasting an image makes it available to remote pi and inserts its server path into the editor.
  - Goal: Supply the image to the remote agent.
  - Goal achievement: Full for image delivery. The user does not copy the file or correct its path manually.
- FRQ-02: Operation does not require a local pi process.
  - Goal: Preserve remote-only pi startup.
  - Goal achievement: Full for this constraint. A local helper is acceptable.
- FRQ-03: A one-time setup script saves the configuration and enables automatic helper startup and tunnel management. Later connections require no separate manual tunnel creation or helper process startup.
  - Goal: Keep daily use simple while preserving ordinary SSH connections.
  - Goal achievement: Full for startup automation. The user does not manage these operations for each connection.
- FRQ-04: Support an optional SSH password. Without a configured password, use the user's configured SSH authentication.
  - Goal: Allow automatic connections without requiring SSH keys.
  - Goal achievement: Full for authentication choice. Password authentication and key-based authentication use SSH, not a separate authentication system.
- FRQ-05: The local helper maintains simultaneous tunnels to every configured SSH target. Adding or updating one SSH target preserves all other target settings.
  - Goal: Use image paste on multiple remote servers from one local computer.
  - Goal achievement: Full for concurrent server use. Each remote pi can request the local clipboard image through its tunnel.
- FRQ-06: Setup provides a command that removes one exact SSH target. When other targets remain, the helper restarts their tunnels. Removing the last target deletes the helper configuration, runtime diagnostics file, installed executable, and autostart registration.
  - Goal: Remove obsolete servers without damaging active server configurations.
  - Goal achievement: Full for configuration removal and final uninstall.

### Non-functional requirements

- NRQ-01: Support macOS, Linux with a systemd-managed graphical user session, and Windows on the local computer, and Linux on the remote server.
  - Goal: Cover the user's target platforms.
  - Goal achievement: Full for the approved platform set.
- NRQ-02: Use an implementation owned by this project, with no dependency on `pasky/pi-ssh-image-clipboard`.
  - Goal: Keep control of the implementation.
  - Goal achievement: Full for independence from that project.
- NRQ-03: Require no new ports for external connections.
  - Goal: Use SSH access without adding external network access requirements.
  - Goal achievement: Full for this network constraint.
- NRQ-04: Use SSH's built-in security for transfer. Do not add a separate security layer, additional authentication, or other protective mechanisms beyond SSH.
  - Goal: Avoid security complexity beyond the user's needs.
  - Goal achievement: Full for the approved architectural constraint. Additional security mechanisms are not optional enhancements to this feature.
- NRQ-05: The local helper does not require an installed Node.js runtime.
  - Goal: Avoid installing Node.js solely to run the helper.
  - Goal achievement: Full for this installation constraint.

## Open questions

None that block approval of the requirements. The implementation of clipboard access and tunnel management remains a technical design decision.

## Technical supplement

The approved password setting for FRQ-04 is the optional `PI_AGENT_SUITE_SSH_PASSWORD` environment variable. Each SSH destination is configured separately through `PI_AGENT_SUITE_SSH_TARGET`, for example `user@server.example`. The exact SSH target string identifies its saved configuration. The password is not embedded in the destination.

## References

- [Problem statement](remote-image_problem.md)
- [Domain glossary](domain-glossary.md)
- [Reference project](https://github.com/pasky/pi-ssh-image-clipboard), an inspected example, not a selected dependency.
