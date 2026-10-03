# Idea: Display an asynchronously pasted image path

## Definitions

See [terms](terms.md).

## Context and problem

See the [problem statement](problem.md). Pi 1.0.0 can update the editor text without refreshing the displayed editor after an asynchronous image transfer.

## Goal

Show the received image path immediately after successful insertion, without another key press.

## Scenarios

- The user presses Ctrl+V, and the image receiver returns a saved PNG path after the initial key event has finished.
- The image clipboard is empty or image transfer fails.

## Scope and non-scope

Scope includes the `remote-image` insertion flow, a regression test, documentation, and an isolated real-pi rendering check.

Changes to installed pi packages, other repositories, terminal configuration, and SSH configuration are outside scope.

## Requirements

### Functional requirements

- [x] FRQ-01: After a successful asynchronous transfer, `remote-image` SHALL make the inserted path visible without another terminal input event.
  - Origin: source; user approved option O2-1.
  - Goal: Make successful paste observable immediately.
  - Goal achievement: Full for this extension's insertion flow.
- [x] FRQ-02: Successful paste SHALL preserve other extensions' statuses and SHALL add no visible status or success notification.
  - Origin: source; the approved option requests redraw without changing visible UI content.
  - Goal: Keep image paste limited to insertion of the path.
  - Goal achievement: Full for unchanged surrounding UI content.

### Non-functional requirements

- [x] NRQ-01: The fix SHALL use pi's public extension API without modifying its installed package.
  - Origin: source; user selected the extension-level workaround in this repository.
  - Goal: Keep the fix in the maintained extension.
  - Goal achievement: Full for the approved repository scope.

## Open questions

None.

## References

- [Technical solution](solution.md)
- [Remote image guide](../../../extensions/remote-image.md)
