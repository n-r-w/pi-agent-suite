# Solution

In `publishWorkflowActivationOptions`, pass `triggerTurn ?? false` to `WorkflowJournal.activationOptions`. Preserve explicit caller values. Pi 1.1.0 defers passive custom messages until tool execution completes, so updated availability enters the active context without occupying the steering queue.

Keep lifecycle records and tool-loop reminders on their existing delivery paths. Keep reasoning-only reminders on `nextTurn`.

## Validation

- Add a unit regression for passive activation-options publication.
- Run both affected CLI integration cases with isolated `one-at-a-time` and `all` settings.
- Record workflow journal metadata in the fixture's `context` handler and associate it with each provider request. Assert reminder timing and workflow identity without checking prompt text.
- Run `bun run test`, `bun run typecheck`, and `bun run check`. Report missing Go tooling separately from TypeScript and Bun results.

## Results

Before the production fix, the new unit case and both `one-at-a-time` integration cases failed. After the fix, all 1,693 Bun tests passed with one existing skip. TypeScript and Biome checks passed. The package scripts could not complete their Go checks because `go` and `gofmt` were unavailable.
