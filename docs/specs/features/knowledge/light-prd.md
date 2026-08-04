# Idea: Cross-Session Project Knowledge

## Definitions

- A knowledge project is one logical remote Git repository across all its clones and worktrees.
- Global knowledge is available in every project branch. Local knowledge belongs to one non-primary branch.
- Strategic knowledge is the rarely changing foundation for project decisions. Tactical knowledge contains changing rules and details for specific domains.
- Knowledge category and knowledge scope are independent.
- The knowledge owner module owns the catalog and exposes independent read, complete replacement, and delete operations.
- Local knowledge accumulation extracts knowledge from the current session and merges it into the active branch's local file.
- Global knowledge accumulation merges the active branch's local file into the project's global file.

## Context and Problem

Pi does not automatically carry agent-discovered knowledge between sessions. The developer must repeat information, maintain `AGENTS.md`, or accept repeated investigation and inconsistent decisions. Unbounded accumulation can also exhaust context and allow frequently changing tactical information to displace the strategic foundation.

## Goal

Give every agent the stored global project knowledge and local knowledge for its active branch without manual transfer while keeping every knowledge file within its configured token limit.

## Scenarios

### Context delivery

- Every model invocation uses the knowledge files stored when provider context is assembled.
- In a non-primary branch, one `<knowledge>` block contains the global and active-branch local knowledge.
- On the primary branch and in detached HEAD state, agents receive global knowledge, but knowledge accumulation is disabled.
- Main agents and subagents receive knowledge under the same rules.

### Local knowledge accumulation

1. Entry into a configured workflow stage starts the named algorithm.
2. The extraction model receives the bundled or configured extraction system prompt and the complete current session after the existing `context-projection` processing.
3. The exact response `NOT_FOUND` ends the algorithm without changes.
4. Any non-empty concise Markdown response is treated as newly identified knowledge.
5. The merge model receives the newly identified knowledge and the stored local file.
6. A result within the file token limit completely replaces the local file.

### Global knowledge accumulation

1. Entry into a configured workflow stage starts the named algorithm.
2. An absent local file ends the algorithm without changes.
3. An unchanged local file since the last successful global merge skips the LLM call.
4. The merge model receives the stored local and global files.
5. An absent global file is treated as an empty input.
6. A result within the file token limit completely replaces the global file.
7. The local file remains unchanged.

### Parallel agent work

- One workflow stage can contain an ordered list of named knowledge algorithms.
- Algorithms run sequentially.
- The active branch queue covers the complete `read → LLM → write` operation.
- The initiating agent waits for its operation. Other agents continue using the last completed knowledge state.
- A failed algorithm skips the remaining algorithms for that stage but does not stop the workflow or agent work.

## Scope and Non-Scope

### Scope

- Personal use by one developer.
- Remote Git repositories and their clones and worktrees.
- One global Markdown file per knowledge project.
- One local Markdown file per non-primary branch.
- Named local and global accumulation algorithms.
- Configurable models, thinking levels, prompts, file token limits, and merge retry count.

### Non-Scope

- Repositories without a remote.
- Shared knowledge between a fork and its upstream repository.
- Knowledge catalog synchronization between machines.
- Collaborative team editing of knowledge.
- Automatic changes to `AGENTS.md`.
- A standalone maintenance or compression algorithm.
- Automatic deletion of local knowledge.
- Partial file updates or item-level knowledge CRUD.
- Atomic file replacement, file locking, or coordination between independent root Pi instances.
- Runtime validation of strategic/tactical structure or proportions.

## Requirements

### Ownership and storage

- The knowledge owner module owns a configurable knowledge catalog.
- Each logical project has a configured primary branch.
- The module contract provides independent `read`, complete replacement, and `delete` operations for global and branch-local Markdown files.
- Complete replacement does not require a preceding `read` operation.
- The owner checks the complete replacement's total token count before opening the target file.
- An over-limit replacement is not written.
- Every knowledge file has its own configured token limit.

### Context assembly

- Every model invocation receives the knowledge stored for the active project and branch when its provider context is assembled.
- Project instructions, including `AGENTS.md`, remain separate context sources and are never modified by the knowledge feature.

### Workflow integration

- A workflow stage contains an ordered list of named knowledge algorithms triggered on stage entry.
- Initial-stage algorithms run when a workflow is created or activated.
- Target-stage algorithms run during `workflow_transition`.
- Re-entry through a rework transition runs the target-stage algorithms again.
- Restoring an already active stage at session start does not rerun algorithms.
- The initiating agent waits for the operation before its next model invocation.

### Models and prompts

- Extraction and merge use separate model and thinking-level configurations.
- An omitted model or thinking level resolves to the values active in Pi when the operation starts.
- The extension ships one extraction system prompt and one shared merge system prompt.
- Configuration can replace either prompt with an absolute file path.
- The extraction prompt requests critical changes, obstacles encountered during work, and information useful to future sessions instead of a session retelling.
- The merge prompt owns concision and the semantic balance between strategic and tactical knowledge.
- Merge output is opaque Markdown. Runtime code does not parse its sections or enforce category proportions.

### Extraction response protocol

- `NOT_FOUND` is the only no-knowledge response and contains no additional text.
- A positive result is non-empty concise Markdown without a required category structure.
- Empty or contract-invalid output is returned to the extraction model with format feedback.
- Extraction retries stop after a finite retry allowance.

### Token-limit retries

- When merge output exceeds the fixed file limit, the merge model receives the actual output token count and the unchanged allowed limit.
- The maximum merge retry count is configurable.
- Exhausting retries leaves the stored file unchanged when direct writing has not started.

### Failure behavior

- Every knowledge-operation failure is non-blocking.
- With TUI, the user receives an error notification. The error is not added to model context.
- Without TUI, failure produces no notification or diagnostic entry.
- Files are overwritten directly without a temporary file or lock.
- A direct-write failure can leave a file partial or damaged.

### Mutation queue

- Within one root Pi process, every agent on the active branch uses one shared FIFO mutation queue.
- One queue item contains the full algorithm from source reads through LLM calls to completed writing.
- Only the initiating agent waits for its queue item.
- Independent root Pi instances use independent queues.
- Concurrent writes from independent instances can cause an undetected lost update; this risk is accepted.

## Open Questions

None.

## Technical Supplement

- Session projection must reuse `pi-package/extensions/context-projection`; the feature must not introduce another projection mechanism.
- Subagents run in separate Pi processes, so the root queue requires a communication path within the owned process hierarchy.
- Bundled prompt wording is not a stable product contract and can change without changing these requirements.

## References

- `docs/specs/features/knowledge/problem-statement.md`
- `docs/specs/features/knowledge/domain-glossary.md`
- `docs/extensions/workflow.md`
- `docs/extensions/context-projection.md`
- `docs/extensions/run-subagent.md`
