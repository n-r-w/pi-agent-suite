# Problem statement

## Context

`remote-image` receives a clipboard image asynchronously and inserts the saved PNG path through pi's `pasteToEditor()` API.

## Observed problem

In Ghostty, the inserted path can remain invisible until the user presses another key. The user reported that Orca displays the path immediately.

## Affected audience

Users who paste images into remote pi while the editor has no other activity that would refresh the screen.

## Evidence

In pi 1.0.0, `InteractiveMode.createExtensionUIContext()` implements `pasteToEditor()` by calling the editor's input handler without requesting a render. The extension shortcut starts the image request asynchronously. The initial key event can finish rendering before image transfer completes.

An isolated check using pi's actual UI context, editor, and TUI classes inserted a path into the editor with zero render requests. A subsequent Shift+Enter produced a render request and revealed the changed text. The regression test for `remote-image` failed because the path was inserted but its rendered editor view remained empty.

## Impact

Users cannot see whether image paste succeeded without performing another editor action.

## Current state

The installed pi API does not schedule a render for programmatic paste. A later terminal input event schedules one. The event responsible for Orca's immediate display has not been identified.

## Desired state

A successful image transfer becomes visible in the editor without another key press.

## Problem boundary

This issue concerns displaying an already-inserted path. Image acquisition, SSH tunnel recovery, and message submission are separate behaviors.

## Open questions

None blocking the extension-level redraw fix. The difference in terminal event timing is not established.
