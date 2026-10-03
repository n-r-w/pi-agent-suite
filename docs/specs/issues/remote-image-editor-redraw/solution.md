# Technical solution: Remote image editor redraw

## Problem statement

See the [problem statement](problem.md). Pi 1.0.0's `pasteToEditor()` changes editor state without requesting a render after an asynchronous shortcut completes.

## Proposed solution

After inserting a saved path, `remote-image` clears its own `remote-image` status through `ctx.ui.setStatus("remote-image", undefined)`. In pi 1.0.0, status updates schedule a render even when no visible status changes. The operation preserves statuses owned by other extensions.

Empty clipboard and failed transfer results retain their notification behavior. The extension requests the extra render only after successful insertion.

### Accepted workaround

Location: `pi-package/extensions/remote-image/index.ts`, immediately after `pasteToEditor()`.

The user approved this extension-level workaround because the public UI API has no direct render-request method. Remove the status-clear workaround when the supported pi version's `pasteToEditor()` schedules its own render. The code contains a TODO with that removal condition.

### Verification

The unit regression checks displayed editor text after asynchronous insertion without another key press. It also checks that other extension statuses remain present and no success notification appears. The test failed before the workaround because the displayed editor text was empty.

An isolated real-pi check loads the extension with a fake delayed image receiver and a temporary agent directory. It sends Ctrl+V only and observes terminal output for the saved path. It uses offline mode, no provider prompt, no real clipboard, and no network request.

## Overengineering and overspecification considerations

One public UI call requests the missing redraw. No editor replacement, timer, notification, terminal-specific branch, or dependency patch is introduced.

## Open questions

None.

## References

- [Requirements](prd.md)
- `pi-package/extensions/remote-image/index.test.ts` contains the regression test.
- Pi 1.0.0's `InteractiveMode.setExtensionStatus()` calls the TUI's `requestRender()` after updating status data.
