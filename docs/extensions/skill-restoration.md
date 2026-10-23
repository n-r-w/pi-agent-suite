# skill-restoration

After native or custom compaction, `skill-restoration` returns previously loaded skill files to the model context. On the first model request after a compaction, it reads the files from disk and selects the whole files that fit. It saves the selected files with their contents in the session and inserts them immediately after the compaction summary in every request until the next compaction. Main agents and subagents load the extension through the package.

## Configuration

The optional file `~/.pi/agent/agent-suite/skill-restoration/config.json` accepts one key:

```json
{
  "enabled": true
}
```

`PI_AGENT_SUITE_DIR` overrides the suite directory. Missing configuration enables restoration. The extension rereads configuration on lifecycle and request events. Invalid JSON, unknown keys, read errors, or a non-boolean `enabled` value disable restoration and produce one warning per extension instance.

## Candidate paths

A successful `read` result qualifies when its resolved path belongs to a directory listed by Pi's skill command catalog. Skill commands also qualify through their `location` attribute. Assets and subdirectories qualify. Bash reads and unrelated project files are excluded.

When a compaction completes, the extension reconstructs effective messages before the latest active-branch compaction, including context-edit omissions and replacements. Files loaded successfully in messages retained after compaction remain in place and are excluded. Recent loads have priority. Previous candidate paths retain their relative priority across compactions, including paths that did not fit or were missing.

Each compaction gets one immutable `skill-restoration` session record containing its compaction ID and ordered candidate paths.

## Selection

On the first request after a compaction, the extension reads the candidate files from disk and selects the files to restore. It skips a missing or unreadable file for this selection; the path stays among the candidates of later compactions. The extension saves the result in one immutable `skill-restoration-selection` session record: the compaction ID, the path and contents of each restored file, and the readable paths that did not fit.

The selection limit is the selected model's context window minus Pi's model-specific `reserveTokens` and `keepRecentTokens`. The `keepRecentTokens` headroom leaves room for work, so restored files do not trigger the next compaction at once. The extension uses the shared o200k_base estimator for the complete request: the selected system head, resolved tool declarations, summary, retained messages, new input, inserted framing, restored files, and absent-file list. Provider token accounting and billing can differ from this estimate.

When all readable files fit, the extension selects the whole set. Otherwise it considers files most-recent-first and continues considering smaller files after a larger file fails to fit. With zero headroom and at least one readable file, the selection contains only absent paths. The absent-file list has an irreducible size and may exceed the available budget. Missing models or invalid native compaction settings postpone the selection to a later request.

Pi hides system messages from ordinary `context` handlers. The extension obtains the merged native system head through public session projection. This head contains preserved system content, named sections, and resolved tool declarations.

The extension retains the public `before_agent_start.systemPromptOptions` object by reference, so it observes prompt overrides from later handlers. When the final `forceSystemPrompt` value is undefined, the extension estimates the native head. When the value is defined, including an empty string, the extension estimates a forced head containing that value and the native tool declarations. Pi omits native named sections from the forced head.

During compaction and continuation within an active run, the extension retains the options reference. On each `before_agent_start`, it replaces the reference. On session start or shutdown, it clears the reference.

## Insertion

For each request after the selection, the extension inserts one message with the saved file contents immediately after the latest compaction summary. The message lists the absent paths and instructs the model to read each of them before relevant work. The extension inserts the same message whatever the request size, file changes on disk, model, or prompt, so the model keeps the restored instructions until the next compaction. Reopening a session or navigating its tree uses the selection record of the latest compaction on that branch. Malformed path records insert nothing; a malformed selection record makes the extension select again.

For example, a compaction tracks 19 files, and 15 of them fit on the first request. Every later request carries the same 15 files and the list of 4 absent paths, also when the request grows close to Pi's compaction threshold or after `/resume`. After the next compaction, the extension selects again from the current files on disk.

Restoration does not queue another turn or add file contents to the next compaction's summarizer. Provider cache hits depend on the provider. Pi's canonical context estimate can omit context-only insertions.

## Display and package order

The compact entry renderer of a path record reports the tracked-file count, and Ctrl+O lists tracked paths. The compact renderer of a selection record reports the restored-file count, estimated inserted tokens, and absent-file count; Ctrl+O lists restored and absent paths. The run-subagent conversation screen excludes these custom entries.

The package loads `context-projection`, then `skill-restoration`, then `compaction-trigger`. Projection maps session sources before insertion; the trigger can then block the whole request.

## Storage and limitations

Each compaction adds a path record and a selection record to the session file. The selection record holds the full text of the restored files: for example, 58,000 tokens of skill text take about 230 KB at 4 characters per token. Existing ordinary read results remain ordinary session history. The inserted message itself has no separate persisted transcript entry. `consult-advisor` uses session replay and does not receive that inserted message.

The absent-file instruction depends on model compliance. Restoration does not retry reads or guarantee that the model follows the instruction.
