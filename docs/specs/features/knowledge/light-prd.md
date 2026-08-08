# Idea: Cross-Session Project Knowledge

## Definitions

- A knowledge project is one logical remote Git repository across its clones and linked worktrees. A fork is a separate project.
- A project key is a deterministic SHA-256 key derived from one versioned, standard fetch URL identity shared by every successfully parsed fetch URL of the current Git context. It is not a permanent Git repository identifier.
- Global knowledge is available in every project branch. Local knowledge belongs to one non-primary branch.
- Strategic knowledge is the rarely changing foundation for project decisions. Tactical knowledge contains changing rules and details for specific domains.
- Knowledge category and knowledge scope are independent.
- The knowledge owner module owns the catalog and exposes independent read, complete replacement, and delete operations.
- Local knowledge accumulation extracts knowledge from the current session and merges it into the active branch's local file.
- Global knowledge accumulation merges the active branch's local file into the project's global file.
- A workflow trigger is a typed action that runs when a workflow enters a stage.

## Context and Problem

Pi does not automatically carry agent-discovered knowledge between sessions. The developer must repeat information, maintain `AGENTS.md`, or accept repeated investigation and inconsistent decisions. Unbounded accumulation can also exhaust context and allow frequently changing tactical information to displace the strategic foundation.

## Goal

Give agents and decision-support model calls the stored global project knowledge and applicable local branch knowledge without manual transfer while keeping every knowledge file within its configured token limit.

## Scenarios

### Project identity

- The current Git context receives a project key only when every fetch URL of every remote can be parsed by a supported identity profile and all results identify one project.
- Supported GitHub HTTPS and SSH URL forms for one repository produce the same project key.
- A GitHub repository and a fork under another owner produce different project keys.
- Unsupported URL evidence prevents project identification. Conflicting supported URL evidence produces an ambiguous result. Neither result selects one remote or one partial identity.
- Linked worktrees use remote identity from the common Git repository and use the current worktree's own HEAD for branch scope.
- A submodule is an independent Git context. It shares a project key with another Git context only when both resolve to the same remote identity.

### Context delivery

- Every main-agent and subagent model invocation uses the knowledge stored when provider context is assembled.
- `ask-llm`, `consult-advisor`, every `convene-council` participant, and `subagent_query` receive the same applicable knowledge in their explicit request contexts.
- In a non-primary branch, one `<knowledge>` block contains the global and active-branch local knowledge.
- On the primary branch and in detached HEAD state, model requests receive global knowledge, but knowledge accumulation is disabled.
- A bare repository with a resolved project key receives global knowledge, but knowledge accumulation is disabled.

### Local knowledge accumulation

1. Entry into a workflow stage containing `local_knowledge_accumulation` starts the algorithm.
2. The extraction model receives the bundled or configured extraction system prompt and the complete current session after existing `context-projection` processing.
3. The exact response `NOT_FOUND` ends the algorithm without changes.
4. Any non-empty concise Markdown response is treated as newly identified knowledge.
5. The merge model receives the newly identified knowledge and the stored local file.
6. A result within the local file token limit completely replaces the local file.

### Global knowledge accumulation

1. Entry into a workflow stage containing `global_knowledge_accumulation` starts the algorithm.
2. An absent local file ends the algorithm without changes.
3. An unchanged local file since the last successful global merge skips the LLM call.
4. The merge model receives the stored local and global files.
5. An absent global file is treated as an empty input.
6. A result within the global file token limit completely replaces the global file.
7. The local file remains unchanged.

### Parallel agent work

- One workflow stage can contain an ordered list of triggers.
- Triggers run sequentially in listed order.
- The active branch queue covers the complete `read → LLM → write` operation.
- The initiating agent waits for its operation. Other agents continue using the last completed knowledge state.
- A failed trigger skips the remaining triggers for that stage but does not stop the workflow or agent work.

## Scope and Non-Scope

### Scope

- Personal use by one developer.
- Remote Git repositories, their clones, linked worktrees, and initialized submodules.
- One global Markdown file per knowledge project.
- One local Markdown file per non-primary branch.
- Local and global accumulation trigger types.
- Configurable models, thinking levels, prompts, file token limits, fraction denominators, primary-branch variants, and data directory.
- Automatic fail-closed project-key derivation from supported fetch URL forms.

### Non-Scope

- Repositories without a fetch URL.
- Shared knowledge between a fork and its upstream repository.
- Knowledge catalog synchronization between machines.
- Collaborative team editing of knowledge.
- Automatic changes to `AGENTS.md`.
- A standalone maintenance or compression algorithm.
- Automatic deletion of local knowledge.
- Partial file updates or item-level knowledge CRUD.
- Atomic file replacement, file locking, or coordination between independent root Pi instances.
- Runtime validation of strategic/tactical structure or proportions.
- Provider API calls for repository identity.
- Automatic catalog migration after repository rename, transfer, deletion, or remote namespace reuse.
- Local-path, `file://`, FTP/FTPS, remote-helper, malformed, credential-bearing, or unknown fetch URL forms in the first identity format.

## Requirements

### Default configuration

- `knowledge/config.json` under the active agent-suite directory is optional.
- Knowledge is enabled when `enabled` is omitted or `true`.
- The data directory defaults to `knowledge/data` under the active agent-suite directory.
- The global file token limit defaults to 5,000 tokens.
- Every local file token limit defaults to 5,000 tokens.
- Extraction and merge model settings default to the model active in the initiating Pi process when the operation starts.
- Extraction and merge thinking settings default to the thinking level active in the initiating Pi process when the operation starts.
- Bundled extraction, local-merge, and global-merge system prompts are used when prompt-file overrides are omitted.
- The maximum fraction denominator defaults to eight for every operation and accepts integers from four to thirty-two.
- The initial size target defaults to two thirds of an A4 page for every operation.
- The retry reduction coefficient defaults to three quarters for every operation.
- Primary-branch variants default to `main` and `master`.
- Configuration can override each default independently.
- A present configuration file accepts only documented fields. Invalid JSON, unsupported fields, invalid values, or unreadable configured prompt files reject the configuration.

### Project identity

- `git rev-parse --absolute-git-dir` verifies that the working directory is in a Git context.
- `git rev-parse --path-format=absolute --git-common-dir` identifies the common Git directory used to read remote identity for normal repositories and linked worktrees.
- No local filesystem path participates in the project key.
- The resolver collects every effective fetch URL of every remote from the common repository configuration. Git `insteadOf` expansion applies before identity parsing.
- Every collected fetch URL must parse successfully through one supported profile.
- Project resolution succeeds only when the set of `<profile, standard-name>` pairs contains exactly one item.
- No fetch URL returns `unidentified`. Any unsupported or prohibited URL returns `unsupported`. More than one recognized pair returns `ambiguous`.
- Resolved projects are `resolved-read-only` when accumulation is prohibited and `resolved-read-write` otherwise.
- Remote names, active branch upstream, push destinations, refs, commits, history, and remote HEAD do not participate in the project key.

### `github-v1` identity profile

- `github-v1` accepts only these forms, with optional terminal `.git` where shown:
  - `https://github.com/<owner>/<repository>`
  - `git@github.com:<owner>/<repository>`
  - `ssh://git@github.com/<owner>/<repository>`
  - `ssh://git@github.com:22/<owner>/<repository>`
  - `ssh://git@ssh.github.com:443/<owner>/<repository>`
- The path contains exactly two non-empty segments: owner and repository.
- The SSH user is exactly `git`. HTTPS userinfo, SSH password-like userinfo, query, fragment, percent escapes, extra path segments, and trailing slash are prohibited.
- The profile removes exactly one terminal ASCII `.git`. The remaining repository name must be non-empty.
- Owner and repository are converted to lowercase.
- The standard name is `github.com/<lowercase-owner>/<lowercase-repository>`.

### `generic-uri-v1` identity profile

- `generic-uri-v1` accepts standard `http`, `https`, `ssh`, and `git` URIs with a non-empty host and repository path.
- Scheme and host are converted to lowercase.
- Standard ports are removed only for their matching schemes: `http:80`, `https:443`, `ssh:22`, and `git:9418`.
- Percent-encoded unreserved characters are decoded independently within each URI component. Remaining percent escapes use uppercase hexadecimal digits.
- The unreserved set is `A-Z`, `a-z`, `0-9`, `-`, `.`, `_`, and `~`.
- Path case, `.git`, trailing slash, query, fragment, and SSH username are preserved.
- Empty query and fragment markers remain distinct from absent markers.
- HTTP and HTTPS userinfo and all `git` userinfo are prohibited.
- SSH username is allowed and preserved. SSH password-like userinfo is prohibited.

### `generic-scp-v1` identity profile

- Parsing first rejects NUL and prohibited control characters, then attempts a supported standard URI, then rejects platform-specific local paths, and only then attempts SCP-like syntax.
- `generic-scp-v1` accepts `[user@]host:path` with non-empty host and path.
- Windows drive paths such as `C:\repository` and `C:/repository` are local paths and never SCP-like identities.
- Host is converted to lowercase. Username and path are preserved.
- `.git`, path case, path separators, and trailing slash are not rewritten.

### Project key and directory

- The hash preimage is assembled as bytes in this order:
  1. UTF-8 `pi-agent-suite:knowledge-project:key-v1`;
  2. one `0x00` byte;
  3. UTF-8 identity profile;
  4. one `0x00` byte;
  5. UTF-8 standard name.
- Identity profiles and standard names cannot contain U+0000.
- SHA-256 is encoded as exactly 64 lowercase hexadecimal digits.
- For profile `github-v1` and standard name `github.com/n-r-w/pi-agent-suite`, the digest is `ed0513b170cc4769a82e13527af2de5202188504fae1fc05c30f7a3193a02541`.
- A project directory is named `<readable-prefix>-<full-digest>`.
- The readable prefix is profile-aware: GitHub repository name, final non-empty generic URI path segment, or final non-empty SCP path segment.
- Prefix processing removes one case-sensitive `.git`, applies NFC, preserves Unicode letters, numbers, and marks plus ASCII `.`, `_`, and `-`, replaces every other maximal sequence with `-`, trims decorative edge characters, limits the result to 80 UTF-8 bytes without splitting a code point, trims the end again, and uses `project` when empty.
- NFC and display sanitization never change the profile, standard name, or hash preimage.
- The catalog stores credential-free identity metadata beside project knowledge.
- Documentation states: the key is stable across supported syntactic URL forms, but not across repository rename, transfer, deletion, or remote namespace reuse.

### Ownership and storage

- The knowledge owner owns the configured data directory.
- The default project layout is:

```text
knowledge/data/<project-prefix>-<project-digest>/
  identity.json
  global/
    knowledge.md
  local/
    <branch-prefix>-<branch-digest>/
      knowledge.md
      global-merge-state.json
```

- Branch directory identity uses a SHA-256 digest of the exact branch name plus a readable branch prefix.
- The owner contract provides independent `read`, complete replacement, and `delete` operations for global and branch-local Markdown files.
- Complete replacement does not require a preceding `read` operation.
- The owner counts the complete replacement with the tokenizer already used by the project before opening the target file.
- An over-limit replacement is not written.
- Files are overwritten directly without a temporary file or lock.

### Primary branch and scope

- Configuration can specify a non-empty list of unique primary-branch variants through `primaryBranches`.
- Every variant must be a Git-valid branch name.
- The default variants are `main` and `master`.
- An attached HEAD whose exact branch name matches any configured variant is read-only.
- An attached HEAD whose exact branch name matches no configured variant is read-write.
- Detached HEAD and bare repositories are read-only.
- Remote HEAD evidence does not participate in branch-scope resolution.

### Context assembly

- Applicable knowledge is read when each target model request is assembled.
- Main-agent and subagent turns append one `<knowledge>` block to provider context.
- `ask-llm` and `consult-advisor` append the same block to their explicit system contexts.
- Every `convene-council` participant receives the block in the external council context package.
- `subagent_query` appends the block to its explicit query context.
- Project instructions, including `AGENTS.md`, remain separate context sources and are never modified by the knowledge feature.
- An absent global and local file adds no knowledge block.

### Workflow integration

- A workflow stage contains an optional ordered `triggers` list.
- Each trigger is an object with a required `type` discriminator.
- The initial supported trigger types are `local_knowledge_accumulation` and `global_knowledge_accumulation`.
- Unknown trigger types, unsupported fields, and invalid values reject the workflow.
- Omitted and empty trigger lists run no actions.
- Trigger order and duplicate entries are preserved.
- Initial-stage triggers run after a workflow is created or activated.
- Target-stage triggers run after `workflow_transition`, including rework transitions.
- Restoring an already active stage at session start does not rerun triggers.
- Workflow state is stored before stage triggers run.
- The initiating agent waits for the trigger list before its next model invocation.

### Models and prompts

- Extraction and merge use separate model, thinking, prompt, fraction-denominator, and size-target configurations.
- An omitted model or thinking setting resolves to values active in the initiating Pi process when the operation starts.
- The extension ships one extraction system prompt and separate local and global merge system prompts.
- Configuration can replace either prompt with an absolute file path.
- The extraction prompt requests critical changes, obstacles encountered during work, and information useful to future sessions instead of a session retelling.
- The merge prompt owns concision and semantic balance between strategic and tactical knowledge.
- Merge output is opaque Markdown. Runtime code does not parse its sections or enforce category proportions.

### Extraction response protocol

- `NOT_FOUND` is the only no-knowledge response and contains no additional text.
- A positive result is non-empty concise Markdown without a required category structure.
- Empty or contract-invalid output is a contract error and is never retried.
- Output that exceeds the target file limit or is provider-truncated is retried with a reduced A4-page target.
- Extraction retries continue until the fraction chain reaches its floor `1/maxFractionDenominator`; reaching the floor fails the operation without a write.

### Token-limit retries

- Global and local limits are evaluated independently with `countKnowledgeTextTokens` from `pi-package/shared/context-size.ts`.
- This function counts with the single fixed `o200k_base` encoding.
- Every operation request states a target size as a simple fraction of an A4 page with a fixed 500-word anchor and a hard token ceiling.
- When merge output exceeds the target file limit or is provider-truncated, the next attempt resends the identical request with a reduced A4-page target.
- The reduced target is the previous target multiplied by the operation's reduction coefficient, rounded to the nearest Nth with `N = maxFractionDenominator`, and clamped to the fraction floor `1/N`.
- Every reduced-target retry is announced to the user with its new size before the retried request runs.
- The fraction is a guide; the configured token limit remains the hard ceiling enforced by the owner.
- Reaching the fraction floor `1/maxFractionDenominator` leaves the stored file unchanged when direct writing has not started.

### Failure behavior

- Every identity, read, extraction, merge, queue, IPC, or write failure is non-blocking for workflow and agent work.
- A failed trigger skips the remaining triggers for that stage.
- With TUI, the user receives a safe error notification. The error is not added to model context.
- Without TUI, failure produces no notification or diagnostic entry.
- A direct-write failure can leave a file partial or damaged.
- Independent root Pi instances can produce an undetected lost update; this risk is accepted.

### Mutation queue

- Within one root Pi process, every agent on the active branch uses one shared FIFO mutation queue.
- One queue item contains the full algorithm from source reads through LLM calls to completed writing.
- Only the initiating agent waits for its queue item.
- During a queued direct write, other same-root requests receive the last completed global and local snapshots.
- Child cancellation, disconnect, owner shutdown, and root shutdown remove queued work or release held work.
- Independent root Pi instances use independent queues.

## Open Questions

None.

## Technical Supplement

### Workflow YAML

```yaml
stages:
  - id: implementation
    description: Implement the approved change
    prompt: Implement only the approved scope
    initial: true
    triggers:
      - type: local_knowledge_accumulation
      - type: global_knowledge_accumulation
```

### Integration boundaries

- Session projection reuses `pi-package/extensions/context-projection`; the feature does not introduce another projection mechanism.
- `run-subagent` transport carries the narrow queue and snapshot protocol required for child Pi processes. Knowledge semantics remain owned by the knowledge extension.
- Prompt wording is not a stable product contract and can change without changing these requirements.

## References

- `docs/specs/features/knowledge/problem-statement.md`
- `docs/specs/features/knowledge/domain-glossary.md`
- `docs/extensions/workflow.md`
- `docs/extensions/context-projection.md`
- `docs/extensions/run-subagent.md`
- https://git-scm.com/docs/git-remote
- https://git-scm.com/docs/git-rev-parse
- https://git-scm.com/docs/git-worktree
- https://www.rfc-editor.org/rfc/rfc3986
- https://docs.github.com/en/get-started/git-basics/managing-remote-repositories
- https://docs.github.com/en/authentication/troubleshooting-ssh/using-ssh-over-the-https-port
- https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository
