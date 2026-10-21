# skill-restoration

After native or custom compaction, `skill-restoration` reads previously loaded skill files from disk for each model request. It inserts whole files that fit immediately after the compaction summary. Main agents and subagents load the extension through the package.

## Configuration

The optional file `~/.pi/agent/agent-suite/skill-restoration/config.json` accepts one key:

```json
{
  "enabled": true
}
```

`PI_AGENT_SUITE_DIR` overrides the suite directory. Missing configuration enables restoration. The extension rereads configuration on lifecycle and request events. Invalid JSON, unknown keys, read errors, or a non-boolean `enabled` value disable restoration and produce one warning per extension instance.

## Selection and persistence

A successful `read` result qualifies when its resolved path belongs to a directory listed by Pi's skill command catalog. Skill commands also qualify through their `location` attribute. Assets and subdirectories qualify. Bash reads and unrelated project files are excluded.

The extension reconstructs effective messages before the latest active-branch compaction, including context-edit omissions and replacements. Files loaded successfully in messages retained after compaction remain in place and are excluded from restoration. Recent loads have priority. Previous candidate paths retain their relative priority across compactions, including paths that did not fit or were missing.

Each compaction creates one immutable session record containing its compaction ID and ordered candidate paths. Restoration persists no file contents, snapshots, rendered messages, or fit decisions. Reopening a session or navigating its tree selects the latest compaction's path record on that branch. Malformed and content-bearing records insert nothing.

## Disk reads and request budget

For each request with an associated path record and compaction summary, the extension reads candidate files from disk. It uses each file's contents at the time of that read. If a file is missing or unreadable, the extension skips it for that request and leaves it off the absent-file list. The path remains tracked, so the extension can restore the file on a later request if it becomes readable. The extension keeps no content cache.

The request limit is the selected model's context window minus Pi's model-specific `reserveTokens` and `keepRecentTokens`. The extension uses the shared o200k_base estimator for the complete request: the selected system head, resolved tool declarations, summary, retained messages, new input, inserted framing, returned files, and absent-file list. Provider token accounting and billing can differ from this estimate.

Pi hides system messages from ordinary `context` handlers. The extension obtains the merged native system head through public session projection. This head contains preserved system content, named sections, and resolved tool declarations.

The extension retains the public `before_agent_start.systemPromptOptions` object by reference, so it observes prompt overrides from later handlers. When the final `forceSystemPrompt` value is undefined, the extension estimates the native head. When the value is defined, including an empty string, the extension estimates a forced head containing that value and the native tool declarations. Pi omits native named sections from the forced head.

During compaction and continuation within an active run, the extension retains the options reference. On each `before_agent_start`, it replaces the reference. On session start or shutdown, it clears the reference.

When all readable files fit, the extension returns the whole set. Otherwise it considers files most-recent-first and continues considering smaller files after a larger file fails to fit. The extension lists readable paths that do not fit and instructs the model to read each file before relevant work. With zero headroom and at least one readable file, the extension delivers only the absent-file list. That list has an irreducible size and may exceed the available budget. Missing models or invalid native compaction settings prevent insertion.

The fitting subset can change as files, request messages, tools, or model settings change. Identical inputs produce deterministic insertion, once per request. Restoration does not queue another turn or add contents to the next compaction's summarizer. Provider cache hits depend on the provider. Pi's canonical context estimate can omit context-only insertions; restoration uses its own complete request estimate.

## Display and package order

Before request preparation, the compact entry renderer reports the tracked-file count. Ctrl+O lists tracked paths. After preparation, the renderer reports the prepared-file count, estimated inserted tokens, and absent-file count for the latest prepared request. The expanded view lists prepared and absent paths. On each repaint, the renderer reads the latest in-memory delivery metadata, including when the entry is already mounted. Reopening or tree navigation clears delivery metadata, so the renderer shows tracked paths until the next request is prepared. The run-subagent conversation screen excludes these custom entries.

The package loads `context-projection`, then `skill-restoration`, then `compaction-trigger`. Projection maps session sources before insertion; the trigger can then block the whole request.

## Storage and limitations

Restoration adds only path records to raw session exports. Existing ordinary read results remain ordinary session history. The request-only restoration message has no separate persisted transcript entry. `consult-advisor` uses session replay and does not receive that inserted message.

Per-request reads add filesystem work. The absent-file instruction depends on model compliance. Restoration does not retry reads or guarantee that the model follows the instruction.
