# Technical Solution: Skill restoration after compaction

## Problem Statement

See `problem.md` and `prd.md`. After compaction, the content of skill files that the model loaded in the summarized range leaves the model context. The solution returns these files to the model context after every compaction kind, in the main agent and in subagents.

## Proposed Solution

A separate `skill-restoration` extension decides after each compaction which skill files return to the context and stores this decision in the session. Before each model request, the extension inserts the stored files right after the compaction summary.

### Extension and configuration

`skill-restoration` is a separate package extension, so it works for `custom-compaction` results and for Pi standard compaction, also when `custom-compaction` is disabled.

The configuration file is `~/.pi/agent/agent-suite/skill-restoration/config.json`, resolved through the shared agent-suite storage helpers, so `PI_AGENT_SUITE_DIR` overrides the root. The file has one key, `enabled`, with the default `true`. A missing file keeps the extension enabled. An unknown key, a value of a wrong type, or malformed JSON makes the configuration invalid: the extension then restores nothing and reports one warning per extension instance. Configuration parsing follows the `cmux` and `project-rules` patterns.

### Restoration record

The restoration record is the main data structure. The extension creates one record per compaction as a `custom` session entry through `pi.appendEntry` and never changes it. The record holds the compaction entry ID, the returned files with their content in insertion order, and the paths of files that did not fit.

The model never receives the record itself. On `session_start` and `session_tree`, the extension selects the record of the latest compaction on the current branch, so restoration keeps working after the session is reopened and after `/tree` navigation (FRQ-01). Persisted session data enters the extension at this point, so the extension checks the record shape here; a malformed record means that the extension inserts nothing.

### Selection of skill files

On `session_compact`, the extension collects skill file paths from Pi's effective context before the compaction, after `context_edit` omissions and replacements (FRQ-01):

- `read` tool calls in the summarized range;
- the `location` attribute of `<skill ...>` blocks that Pi inserts into user messages for `/skill:name`;
- the files of the record of the previous compaction.

Files that the model loaded again inside the retained suffix stay in the context and are excluded.

The extension takes the completed compaction from the latest compaction entry on the current branch. Pi appends the new compaction to the branch before `session_compact`, while the event field `compactionEntry` comes from a lookup by summary text and points to an older entry when two summaries have the same text.

A path counts as a skill file when it lies inside the directory of a skill from the Pi skill list (FRQ-02). The extension takes this list from `pi.getCommands()`: for entries with `source: "skill"`, `sourceInfo.path` is the `SKILL.md` path, and its directory is the skill directory. Pi's default and metadata resource-loading paths set `sourceInfo.path` to the skill file path. A custom resource-loader override remains responsible for the provenance it supplies. This list is available at `session_compact`, which `systemPromptOptions.skills` of `before_agent_start` does not guarantee, for example when the user runs `/compact` right after reopening a session.

### Content and budget

The extension reads each selected file from disk when the compaction completes. A file that no longer exists is skipped. If a skill changed after the model read it, the model receives the current version.

The free space for skill files equals the model context window minus Pi `reserveTokens`, minus Pi `keepRecentTokens`, minus the estimated context after compaction: system prompt, active tools, summary, and retained suffix (FRQ-03). `keepRecentTokens` keeps room for work before the next compaction, so the returned skills do not trigger another compaction on the next turn. The estimate uses the shared `o200k_base` estimator in `shared/context-size.ts`, which `custom-compaction` also uses, and covers the whole inserted message, including the list of files that did not fit.

Pi reads `reserveTokens` and `keepRecentTokens` for the current model, so `compaction.modelOverrides` can replace the ordinary values. The shared helper `readNativeCompactionSettings` reads them without a model now. The helper gets the current model as an argument, and `skill-restoration`, `compaction-trigger`, and `footer` pass it. All three then use the values that Pi applies. Example: with a 100,000-token window, ordinary `reserveTokens` 16,000, and a model override of 8,000, Pi, `compaction-trigger` with zero tolerance, and the footer threshold all use 92,000; before the change, `compaction-trigger` compacted at 84,000. The `compaction-trigger` threshold adds a non-negative tolerance to the same value, so a context below Pi's threshold stays below both.

The extension adds files starting from the most recently loaded one while they fit. The remaining files go into a list that states that their content is absent from the context and that the model must read them before work that they concern. When the context after compaction leaves no free space, no file returns, and the list names every selected file.

### Insertion into the model request

On each `context` event, the extension inserts one message with the record content right after the summary of the latest compaction. The message content stays the same until the next compaction, preserving a stable request prefix. Cache hits depend on the provider. Pi rebuilds every request from the session and passes it through `context` handlers, so the insertion repeats for each request and the context holds one copy of the files.

Pi has provider-usage and canonical-estimate compaction accounting paths. Provider-reported usage of a response includes the inserted files; canonical session estimates do not include context-only insertion. Restoration uses its own complete request estimate for the budget.

### Extension order

`skill-restoration` must stand in `pi-package/package.json` right after `context-projection` and before `compaction-trigger`.

- `context-projection` maps request messages to session entries one to one and skips projection when a request contains a message without a session entry. An earlier insertion would silently stop context projection after the first compaction.
- `compaction-trigger` blocks a request by returning an empty message list. A later insertion would add skill files to a blocked request.
- `compaction-trigger` takes its estimate from `ctx.getContextUsage()`, so `skill-restoration` between the two extensions does not change this estimate. The order test of `compaction-trigger` and the order statement in `docs/extensions/compaction-trigger.md` change accordingly.

A package order test pins this order, following `compaction-trigger/package-order.test.ts`.

### User interface

The extension renders the restoration record in the TUI through `pi.registerEntryRenderer`, as `custom-compaction` renders its outcome entry. The compact view is one line with the counts, for example `[skill-restoration] Restored 14 skill files (~37k tokens); 2 files did not fit`. The expanded view adds the paths of the returned files and of the files that did not fit. The subagent screen of `run-subagent` shows no `custom` entries of other extensions, so the line appears only on the main screen.

### Shared skill path rule

The rule "a file lies inside a skill directory" and the resolution of `read` paths (cwd, `~`, `@` prefix) are now private to `shared/context-projection.ts`. They move to a shared module that `context-projection` and `skill-restoration` both use, so both extensions apply one rule.

The current rule treats a relative path that starts with `..` as outside the directory, so a skill file named `..notes.md` counts as an outside file. The shared rule treats a path as outside only when the relative path equals `..`, starts with `../`, or is absolute. Example: `<skill>/..notes.md` is a skill file, and `<skill>/../other.md` is not.

### System prompt

The skill guidelines in `system-prompt/prompts/system.md` stop telling the model to read a skill again after compaction or summary (FRQ-04). The instruction to read a skill again when an earlier read was truncated stays.

### Rejected options

- Delivery through `pi.sendMessage` after `session_compact`, as `mcp-wrapper` and `workflow` do. A message with `triggerTurn: false` reaches the context only after the next model response when Pi compacts between turns; a steered message starts an extra model turn when Pi compacts at the end of a run. The next compaction would also send the skill content to the summarizer.
- Skill content appended to the summary text inside `custom-compaction`. Pi standard compaction has no such hook, so this option fails for standard compaction.
- Restoration inside `custom-compaction`. Its `enabled` setting would also control restoration, while it controls only summary generation.

### Trade-offs

- The inserted restoration message is not a separate persisted transcript entry. Raw session exports include the custom record and its stored file contents. `consult-advisor` does not receive the context-only inserted message.
- Each compaction adds the returned file content to the session file: a median of about 149,000 characters in the sampled sessions.
- `custom-compaction` sizes the summary without the returned skills, so the summary gets space first and skills get the rest.
- `compaction-trigger` no longer follows `context-projection` directly in the extension list.
- Users with `compaction.modelOverrides` see `compaction-trigger` compact at a different token count, and the footer show a different threshold, than before the change: both now match Pi.
- `context-projection` keeps read results of skill files named with a leading `..` complete, where it could replace them before.

## Overengineering and Overspecification Considerations

- Persisted record: FRQ-01 requires restoration after the session is reopened.
- Record shape check: persisted session data has the type `unknown` when the extension reads it back.
- Budget, recency order, and `keepRecentTokens` headroom: FRQ-03 and the user decision on headroom.
- Skipping missing files: skills are edited and renamed during sessions, and reading a missing file fails.
- Configuration, TUI line, and order test: user decisions.
- Shared skill path module: one rule for FRQ-02 in two extensions.
- Model-aware compaction settings in `compaction-trigger` and `footer`: user decision; without it, `skill-restoration` can fill the context above the `compaction-trigger` threshold for users with model overrides.
- Leading `..` file name fix: user decision; FRQ-02 covers every file name in a skill directory.

The solution has no separate headroom setting, no display of file content, and no subagent screen support. The implementer decides the text format of the inserted message, the record field names, and the exact TUI text.

## Open Questions

None. Risk R1 from `prd.md`, whether the model reads the files from the list of files that did not fit, is checked with a live `pi` run during the dry run.

## References

- `problem.md` - problem statement
- `prd.md` - requirements
- `docs/extensions/custom-compaction.md` - compaction summary generation
- `docs/extensions/context-projection.md` - request projection
- `docs/extensions/compaction-trigger.md` - compaction threshold enforcement
