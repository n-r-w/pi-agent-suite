# Technical solution: Agent registry warnings

## Problem statement

See [problem statement](problem.md) and [requirements](prd.md).

## Proposed solution

- The shared registry reports warnings through a caller-provided reporter. Main-agent-selection and run-subagent use one session-scoped reporter, shared through Pi's event bus because Pi loads separate shared-module copies for each extension.
- The reporter displays each distinct warning once per session. Either extension supplies the notification context. Interactive sessions display `warning` notifications; sessions without a UI receive warnings on stderr. A changed rejection reason produces a new warning. A new session starts a fresh warning set.
- Definition validation reports the rejected field and its expected shape. YAML failures retain the parser message, including its line, column, and source excerpt.
- Failed reads and validation skip the affected definition. Failed directory reads leave other registry sources available. Missing optional directories remain normal.
- The project overlay reports all conflicting filenames before excluding their NFC-normalized identity. Project precedence remains intact, so a broken or ambiguous project definition still reserves its identity.

For example, an unindented continuation of `tools: [read,` produces a warning naming the Markdown file and the YAML indentation error. Pi still accepts the next input.

## Overengineering and overspecification considerations

The registry retains its array result and overlay policy. A warning callback connects both consumers to a shared reporter. The reporter uses the same synchronous event-bus lookup pattern as agent runtime composition. The warning set exists only in memory; no dependencies or persistent diagnostic files are added.

## Open questions

None.

## References

- [Extension guide](../../../extensions/main-agent-selection.md): agent discovery and warning behavior.
