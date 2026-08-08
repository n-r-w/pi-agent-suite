# Algorithms

The `algorithms` extension owns manual launch of runnable algorithms registered by other extensions. It provides one CLI flag and one slash command per registered algorithm. It does not implement any algorithm itself; extensions register their algorithms through the shared registry.

## Registry

Algorithms register through the shared module `pi-package/shared/algorithm-registry.ts`:

```ts
registerTriggerAlgorithm(pi, {
	type: "local_knowledge_accumulation",
	description: "Accumulate active-branch knowledge into the local file",
	run: async (ctx, signal) => {
		// run the algorithm
		return { ok: true };
	},
});
```

- `type` is the unique algorithm identifier used by the CLI flag and slash command.
- `description` is shown in the slash command and TUI autocomplete.
- `run` receives the initiating context and an optional cancellation signal.
- Registering the same type twice replaces the previous entry.
- Registration happens at extension load so the registry is populated before `session_start`.

The knowledge extension registers `local_knowledge_accumulation` and `global_knowledge_accumulation`. The workflow extension is a client of registered algorithms through its own runner; it does not register or own them.

## CLI flag

| Flag | Type | Description |
| --- | --- | --- |
| `--trigger <type>` | String | Runs a registered algorithm at startup, then exits. |

When `--trigger` is set, the extension resolves the type from the shared registry at `session_start`. A registered algorithm runs and the session shuts down; the flag is ignored in child agent processes.

The process exit code reports the run outcome:
- A registered algorithm that returns `{ ok: true }` prints `[trigger] <type> completed` and exits with code 0.
- A registered algorithm that returns `{ ok: false }` prints `[trigger] <type> failed` and exits with code 1.
- An unknown type writes `unknown trigger type: <type>` to stderr and exits with code 1.

## Slash commands

At `session_start`, the extension registers one slash command per registered algorithm:

- `/trigger:<type>` runs the algorithm interactively without shutting down the session.

The command name uses the skill-like colon syntax so the TUI autocomplete shows all available types. Progress and failures are reported by the owning extension through its existing notification channel.

## Manual model calls

The extension makes no model calls of its own. All model work is performed by the registered algorithms.
