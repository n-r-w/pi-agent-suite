# Knowledge

The `knowledge` extension keeps bounded project knowledge across Pi sessions. It supplies global project knowledge and active-branch local knowledge to agents and configured decision-support model calls.

## Configuration

Default file:

```text
~/.pi/agent/agent-suite/knowledge/config.json
```

When `PI_AGENT_SUITE_DIR` is set, the extension uses `<PI_AGENT_SUITE_DIR>/knowledge/config.json`.

The file is optional. Missing configuration enables the extension with defaults.

```json
{
  "enabled": true,
  "dataDir": "/absolute/path/to/knowledge-data",
  "globalTokenLimit": 5000,
  "localTokenLimit": 5000,
  "primaryBranches": ["main", "master"],
  "extraction": {
    "model": "analyst-complex",
    "thinking": "medium",
    "systemPromptFile": "/absolute/path/to/extraction.md",
    "retryCount": 1
  },
  "merge": {
    "model": "review-fast",
    "thinking": "medium",
    "systemPromptFile": "/absolute/path/to/merge.md",
    "retryCount": 2
  }
}
```

All fields are optional.

| Parameter | Type or shape | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | Boolean | `true` | Enables knowledge delivery and accumulation. |
| `dataDir` | Absolute directory path | `<agent-suite>/knowledge/data` | Stores project knowledge catalogs. |
| `globalTokenLimit` | Positive safe integer | `5000` | Maximum tokenizer count for one global knowledge file. |
| `localTokenLimit` | Positive safe integer | `5000` | Maximum tokenizer count for each local branch knowledge file. |
| `primaryBranches` | Non-empty array of unique Git-valid branch names | `["main", "master"]` | Disables accumulation on every listed branch. |
| `extraction` | Object | Defaults below | Configures session knowledge extraction. |
| `extraction.model` | Non-empty string | Current initiating model | Selects the extraction model. Accepts either `provider/model` or an alias from `model-aliases/config.json`. |
| `extraction.thinking` | `off`, `minimal`, `low`, `medium`, `high`, or `xhigh` | Current initiating thinking level | Selects extraction reasoning. |
| `extraction.systemPromptFile` | Readable non-empty absolute file path | Bundled extraction system prompt | Replaces the extraction system prompt. |
| `extraction.taskPromptFile` | Readable non-empty absolute file path | Bundled extraction task prompt | Replaces the extraction task prompt attached after `<summary_source>`. |
| `extraction.retryCount` | Non-negative safe integer | `1` | Number of format-correction retries after the initial extraction response. |
| `merge` | Object | Defaults below | Configures local and global knowledge consolidation. |
| `merge.model` | Non-empty string | Current initiating model | Selects the merge model. Accepts either `provider/model` or an alias from `model-aliases/config.json`. |
| `merge.thinking` | `off`, `minimal`, `low`, `medium`, `high`, or `xhigh` | Current initiating thinking level | Selects merge reasoning. |
| `merge.systemPromptFile` | Readable non-empty absolute file path | Bundled merge prompt | Replaces the merge system prompt. |
| `merge.retryCount` | Non-negative safe integer | `2` | Number of shortening retries after the initial over-limit merge response. |

Unknown fields, invalid JSON, invalid values, and unreadable or empty configured prompt files disable the extension. In TUI mode, Pi shows a fixed error notification without the private configuration value.

Configuration is read when the extension loads. Restart Pi to apply changes.

## Project identity

The extension derives one project key from every effective fetch URL of every remote in the common Git repository configuration:

1. Git expands `url.*.insteadOf` through `git remote get-url --all`.
2. Every URL must match `github-v1`, `generic-uri-v1`, or `generic-scp-v1`.
3. Every parsed URL must produce the same identity profile and standard name.
4. The extension hashes the versioned identity with SHA-256 and encodes the complete digest as lowercase hexadecimal.

`github-v1` equates the documented GitHub HTTPS, SCP-like SSH, `ssh://git@github.com`, and `ssh://git@ssh.github.com:443` forms. Generic profiles preserve transport and path details instead of assuming provider equivalence.

Project identity fails closed:
- no fetch URL produces no project;
- one unsupported URL rejects all evidence;
- multiple recognized identities are ambiguous;
- remote names, push URLs, active branch upstream, refs, commits, and history do not select a project.

The key is stable across URL forms explicitly supported by one profile. It is not stable across repository rename, transfer, deletion, remote namespace reuse, or other URL identity changes. The extension does not call provider APIs or migrate catalogs between keys.

Linked worktrees read remote identity from their common Git directory and use the current worktree's own HEAD for branch scope. A submodule is an independent Git context. Bare repositories are read-only.

## Storage layout

The default layout is:

```text
knowledge/data/<project-name>-<project-sha256>/
  identity.json
  global/
    knowledge.md
  local/
    <branch-name>-<branch-sha256>/
      knowledge.md
      global-merge-state.json
```

Readable prefixes are diagnostic. Complete SHA-256 values determine project and branch directory identity.

Each Markdown replacement is counted before its target directory or file is opened. Counting uses the project's existing `js-tiktoken` integration through `estimateTextTokens(text, undefined, undefined)`.

Files are overwritten directly. The extension does not use temporary replacement files or file locks.

## Knowledge delivery

Applicable knowledge is read when a target request is assembled:
- main-agent and subagent turns receive one `<knowledge>` system-prompt block;
- `/ask` receives the block in its explicit system context;
- `consult_advisor` receives the block in its explicit system context;
- every `convene_council` participant receives the block in the shared external context package;
- `subagent_query` receives the block in its explicit query context.

A non-primary attached branch receives global and branch-local knowledge. A configured primary branch, detached HEAD, and bare repository receive global knowledge only. Absent files add no block.

Project instruction files, including `AGENTS.md`, remain separate and are never modified.

## Workflow triggers

Knowledge accumulates only when a workflow enters a stage containing a supported trigger. In TUI mode, the extension reports operation progress with informational notifications. Local accumulation reports preparation and merge separately:
- `[knowledge] preparing local knowledge summary...`
- `[knowledge] merging local knowledge...`
Global accumulation reports merge progress:
- `[knowledge] merging global knowledge...`

Knowledge accumulates when a workflow enters a stage containing a supported trigger:

```yaml
stages:
  - id: implementation
    description: Implement the approved change
    prompt: Implement and test the approved change
    triggers:
      - type: local_knowledge_accumulation
      - type: global_knowledge_accumulation
```

`triggers` is ordered and permits duplicate entries. Initial-stage triggers run after workflow creation or activation. Target-stage triggers run after advance and rework transitions. Restoring an active stage at session start runs no triggers.

Workflow state is saved before triggers run. A failed trigger stops the remaining stage triggers but does not fail the workflow operation.

### Local accumulation

1. The extraction model receives one explicit request: `<summary_source> ...projected branch session... </summary_source>` plus the extraction task prompt.
2. The extraction system prompt and task prompt are configured independently.
3. Exact `NOT_FOUND` ends without changes.
4. Empty or contract-invalid output receives format feedback up to `extraction.retryCount`.
5. Positive Markdown is consolidated with stored local knowledge.
6. A within-limit result completely replaces the local file.

### Global accumulation

1. Missing local knowledge ends without changes.
2. A local digest already recorded after the last successful global merge skips the model call.
3. Changed local knowledge is consolidated with global knowledge.
4. A within-limit result completely replaces the global file.
5. After a successful global replacement, the transferred local knowledge file is deleted, and its digest is recorded.

Merge consolidation separates knowledge into two categories: strategic (stable high-leverage project knowledge) and tactical (important but volatile operational knowledge). The replacement Markdown must always keep explicit `## Strategic knowledge` and `## Tactical knowledge` sections. The model must preserve strategic foundations without allowing tactical churn to overwrite them, while still keeping enough tactical risk context for near-term work.

When merge output exceeds the target file limit, the model receives the actual tokenizer count and unchanged limit. Exhausting `merge.retryCount` leaves pre-write storage unchanged.

## Mutation coordination

One FIFO mutation queue exists in each root Pi process. The queue covers source reads, model calls, and direct writing. Descendant agents use the existing `run-subagent` process transport to acquire and release the root queue.

While one mutation is active, concurrent same-root reads for that project and branch receive snapshots captured before the mutation. Idle reads return current storage. Independent root Pi processes do not share a queue and can overwrite each other's updates.

Cancellation, child disconnect, owner shutdown, and root shutdown remove queued work or release an active lease.

## Failures and accepted limits

Knowledge failures do not stop workflow or agent work. TUI mode shows a fixed error notification. Headless modes add no notification or model-context diagnostic.

A direct-write failure can leave a partial file. Independent root processes can cause an undetected lost update. Both behaviors are accepted constraints.

## Detailed specification

- `docs/specs/features/knowledge/light-prd.md`
- `docs/specs/features/knowledge/domain-glossary.md`
