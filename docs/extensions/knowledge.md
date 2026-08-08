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
  "preferredRemotes": ["origin"],
  "extraction": {
    "model": "analyst-complex",
    "thinking": "medium",
    "systemPromptFile": "/absolute/path/to/extraction.md",
    "maxFractionDenominator": 8,
    "initialFraction": "2/3",
    "reductionCoefficient": "3/4"
  },
  "mergeLocal": {
    "model": "review-fast",
    "thinking": "medium",
    "systemPromptFile": "/absolute/path/to/merge-local-system.md",
    "taskPromptFile": "/absolute/path/to/merge-local.md",
    "maxFractionDenominator": 8,
    "initialFraction": "2/3",
    "reductionCoefficient": "3/4"
  },
  "mergeGlobal": {
    "model": "review-fast",
    "thinking": "medium",
    "systemPromptFile": "/absolute/path/to/merge-global-system.md",
    "taskPromptFile": "/absolute/path/to/merge-global.md",
    "maxFractionDenominator": 8,
    "initialFraction": "2/3",
    "reductionCoefficient": "3/4"
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
| `preferredRemotes` | Non-empty array of unique Git-valid remote names | `["origin"]` | Ordered list of remote names for project identity selection. The first matching remote's identity is used; all others are ignored. |
| `extraction` | Object | Defaults below | Configures session knowledge extraction. |
| `extraction.model` | Non-empty string | Current initiating model | Selects the extraction model. Accepts either `provider/model` or an alias from `model-aliases/config.json`. |
| `extraction.thinking` | `off`, `minimal`, `low`, `medium`, `high`, or `xhigh` | Current initiating thinking level | Selects extraction reasoning. |
| `extraction.systemPromptFile` | Readable non-empty absolute file path | Bundled extraction system prompt | Replaces the extraction system prompt. |
| `extraction.taskPromptFile` | Readable non-empty absolute file path | Bundled extraction task prompt | Replaces the extraction task prompt attached after `<summary_source>`. |
| `extraction.maxFractionDenominator` | Integer from `4` to `32` | `8` | Largest fraction denominator accepted for this operation. Drives fraction validation, formatting, and the minimum fraction floor `1/N`. |
| `extraction.initialFraction` | Simple fraction string `n/d` with denominator at most `maxFractionDenominator` | `"2/3"` | Initial target size of the extraction output as a fraction of an A4 page. |
| `extraction.reductionCoefficient` | Simple fraction string `n/d` with denominator at most `maxFractionDenominator` | `"3/4"` | Multiplier applied to the target fraction on each size-correction retry. |
| `mergeLocal` | Object | Defaults below | Configures active-branch local knowledge consolidation. |
| `mergeLocal.model` | Non-empty string | Current initiating model | Selects the local merge model. Accepts either `provider/model` or an alias from `model-aliases/config.json`. |
| `mergeLocal.thinking` | `off`, `minimal`, `low`, `medium`, `high`, or `xhigh` | Current initiating thinking level | Selects local merge reasoning. |
| `mergeLocal.systemPromptFile` | Readable non-empty absolute file path | Bundled local merge system prompt | Replaces the local merge system prompt. |
| `mergeLocal.taskPromptFile` | Readable non-empty absolute file path | Bundled local merge task prompt | Replaces the local merge task prompt attached after `</incoming_knowledge>`. |
| `mergeLocal.maxFractionDenominator` | Integer from `4` to `32` | `8` | Largest fraction denominator accepted for this operation. Drives fraction validation, formatting, and the minimum fraction floor `1/N`. |
| `mergeLocal.initialFraction` | Simple fraction string `n/d` with denominator at most `maxFractionDenominator` | `"2/3"` | Initial target size of the local merge output as a fraction of an A4 page. |
| `mergeLocal.reductionCoefficient` | Simple fraction string `n/d` with denominator at most `maxFractionDenominator` | `"3/4"` | Multiplier applied to the target fraction on each shortening retry. |
| `mergeGlobal` | Object | Defaults below | Configures global knowledge consolidation. |
| `mergeGlobal.model` | Non-empty string | Current initiating model | Selects the global merge model. Accepts either `provider/model` or an alias from `model-aliases/config.json`. |
| `mergeGlobal.thinking` | `off`, `minimal`, `low`, `medium`, `high`, or `xhigh` | Current initiating thinking level | Selects global merge reasoning. |
| `mergeGlobal.systemPromptFile` | Readable non-empty absolute file path | Bundled global merge system prompt | Replaces the global merge system prompt. |
| `mergeGlobal.taskPromptFile` | Readable non-empty absolute file path | Bundled global merge task prompt | Replaces the global merge task prompt attached after `</incoming_knowledge>`. |
| `mergeGlobal.maxFractionDenominator` | Integer from `4` to `32` | `8` | Largest fraction denominator accepted for this operation. Drives fraction validation, formatting, and the minimum fraction floor `1/N`. |
| `mergeGlobal.initialFraction` | Simple fraction string `n/d` with denominator at most `maxFractionDenominator` | `"2/3"` | Initial target size of the global merge output as a fraction of an A4 page. |
| `mergeGlobal.reductionCoefficient` | Simple fraction string `n/d` with denominator at most `maxFractionDenominator` | `"3/4"` | Multiplier applied to the target fraction on each shortening retry. |

Unknown fields, invalid JSON, invalid values, and unreadable or empty configured prompt files disable the extension. The validation reason is written to stderr in every mode and shown as an error notification in TUI mode without the private configuration value.

Configuration is read when the extension loads. Restart Pi to apply changes.

## Project identity

The extension derives one project key from effective fetch URLs of remotes in the common Git repository configuration:

1. Git expands `url.*.insteadOf` through `git remote get-url --all` for every remote.
2. If a remote listed in `preferredRemotes` exists, only that remote's URLs are considered; all other remotes are ignored. The first matching remote in the configured order wins. When no configured remote is found, all remotes are considered.
3. Every considered URL must match `github-v1`, `generic-uri-v1`, or `generic-scp-v1`.
4. Every parsed URL must produce the same identity profile and standard name.
5. The extension hashes the versioned identity with SHA-256 and encodes the complete digest as lowercase hexadecimal.

`github-v1` equates the documented GitHub HTTPS, SCP-like SSH, `ssh://git@github.com`, and `ssh://git@ssh.github.com:443` forms. Generic profiles preserve transport and path details instead of assuming provider equivalence.

Project identity fails closed:
- no fetch URL produces no project;
- one unsupported URL among considered remotes rejects all evidence;
- multiple recognized identities among considered remotes are ambiguous;
- push URLs, active branch upstream, refs, commits, and history do not select a project.

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

Each Markdown replacement is counted before its target directory or file is opened. Counting uses the single fixed `o200k_base` encoding through `countKnowledgeTextTokens` from `pi-package/shared/context-size.ts`.

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

Knowledge accumulates when a workflow enters a stage containing a supported trigger, or when the user runs an accumulation algorithm manually through the `algorithms` extension (`/trigger:local_knowledge_accumulation`, `/trigger:global_knowledge_accumulation`, or `pi --trigger <type>`). In TUI mode, the extension reports operation progress with informational notifications. Local accumulation reports preparation and merge separately:
- `[knowledge] preparing local knowledge summary...`
- `[knowledge] merging local knowledge...`
Global accumulation reports merge progress:
- `[knowledge] merging global knowledge...`
Each reduced-target retry is announced with its new size:
- `[knowledge] extraction output too large, retrying with a reduced target (1/2 of an A4 page)...`
- `[knowledge] merge output too large, retrying with a reduced target (1/2 of an A4 page)...`

Workflow-launched accumulation:

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

1. The extraction model receives one explicit request that includes current `<knowledge>...</knowledge>` snapshots and `<summary_source> ...projected branch session... </summary_source>`, followed by the extraction task prompt.
2. The extraction system prompt and task prompt are configured independently.
3. Exact `NOT_FOUND` ends without changes.
4. Empty or contract-invalid output is a contract error and is never retried. Exact `NOT_FOUND` remains the only no-knowledge marker.
5. Positive Markdown is consolidated with stored local knowledge.
6. A within-limit result completely replaces the local file.

### Global accumulation

1. Missing local knowledge ends without changes.
2. A local digest already recorded after the last successful global merge skips the model call.
3. Changed local knowledge is consolidated with global knowledge.
4. A within-limit result completely replaces the global file.
5. After a successful global replacement, the transferred local knowledge file is deleted, and its digest is recorded.

Merge consolidation separates knowledge into two categories: strategic (stable high-leverage project knowledge) and tactical (important but volatile operational knowledge). The replacement Markdown must always keep explicit `## Strategic knowledge` and `## Tactical knowledge` sections. The model must preserve strategic foundations without allowing tactical churn to overwrite them, while still keeping enough tactical risk context for near-term work.

When merge output exceeds the target file limit, the next attempt resends the same request with a reduced A4-page target. Retries continue until the fraction chain reaches its floor `1/maxFractionDenominator`; reaching the floor leaves pre-write storage unchanged.

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
