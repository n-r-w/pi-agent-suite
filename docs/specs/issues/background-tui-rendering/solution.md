# Technical Solution: Avoid unchanged background TUI renders

## Problem Statement

See [problem.md](problem.md).

## Proposed Solution

### Footer usage polling

- Keep the 10-second usage-store polling interval.
- Compare refreshed and cached `cost`, `tokens`, and availability.
- Update cached totals and call `requestRender()` only after a difference.
- Preserve warning and recovery behavior for unavailable usage reads.

### Footer main-agent subscription

- Cache the agent label used by the footer.
- Resolve the next label after each main-agent contribution event.
- Call `requestRender()` only when the label changes.

### Subagent management screen

- Change `ELAPSED_REFRESH_INTERVAL_MS` from 1,000 ms to 10,000 ms.
- Retain the existing conditions that restrict the timer to a visible selected active invocation.

### Codex quota status

- Cache the last status passed to `setStatus()`.
- Skip equal status values from later refreshes.
- Publish status removal during session shutdown and reset the cache for the next session.

### Verification

- Test unchanged and changed footer usage refreshes.
- Test an unchanged main-agent contribution event.
- Test the 10-second subagent elapsed interval.
- Test repeated equal Codex quota results.
- Run the package test, type, lint, format, and loading checks through `bun run verify`.

## Overengineering and Overspecification Considerations

The solution keeps existing polling and event sources. It adds local value comparisons and one cadence change instead of modifying `pi-tui` or introducing a shared rendering framework.

## Open Questions

None.

## References

- `pi-package/extensions/footer/index.ts` - footer polling and contribution subscription.
- `pi-package/extensions/run-subagent/management-screen/screen.ts` - active elapsed-time timer.
- `pi-package/extensions/codex-quota/index.ts` - periodic quota status publication.
