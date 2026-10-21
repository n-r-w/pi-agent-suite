# Skill restoration acceptance report

## Delivered result

The skill-restoration extension persists one ordered path record per compaction. Each request reads current files from disk and inserts whole files that fit immediately after the compaction summary. Restoration adds no file contents, snapshots, rendered messages, fit decisions, or content cache to session storage.

Native and custom compaction, main and child package loading, repeated compaction, branch navigation, session reopening, context edits, retained-load exclusions, missing files, and changed files are covered by behavior tests. The configuration defaults to enabled and accepts only enabled. The main-screen renderer shows tracked paths before preparation and live prepared/absent counts afterward.

Shared skill-path handling recognizes leading-two-dot descendants while excluding parent and sibling paths. Native settings resolution, compaction-trigger, and footer use selected-model token overrides. The package system prompt retains the truncation reread condition and removes post-compaction rereading.

## Local implementation commits

| Unit | Commit | Result |
| --- | --- | --- |
| UNT-01 | `69a351c` | Shared skill ownership and path resolution. |
| UNT-02 | `a2df9dc` | Selected-model reserve and keep-recent settings with migrated callers. |
| UNT-03 | `8e113b8` | Disk-backed restoration with path-only persistence and runtime verification. |

The user-requested rebase used local main at `7e88dc9`; the specification commit became `925b26f`. No remote refs were changed and nothing was pushed.

## Final validation

The main agent ran `bun run verify` after the final code and configuration changes. The command exited 0 and ran all required package scripts. Independent settled reviews also ran the individual scripts successfully.

| Command | Result |
| --- | --- |
| `bun run test` | 1,882 Bun tests passed, 1 existing skip, 0 failed across 1,883 tests and 202 files. Go tests passed. |
| `bun run typecheck` | Strict TypeScript check passed. |
| `bun run check` | Biome checked 450 files; formatting, lint, gofmt, and Go vet passed. |
| `bun run verify` | Exit 0; all of the above passed. |
| `git diff --check` | Passed. |

The existing skipped test is `overflow compaction retries after passive context restoration` in `test/integration/compaction-overflow-retry.test.ts`. This delivery adds no skip. New tests separately exercise automatic overflow compaction and continuation within an active run.

Validation children omitted inherited PI_SUBAGENT_* through child environment objects. The main validation launcher changed neither process.env nor HOME. The corrected post-rebase baseline had 1,839 passing Bun tests, 1 existing skip, and passing Go, typecheck, and lint checks.

Early subagent runs inherited child-mode variables and failed three unchanged agent-registry warning cases. Isolating the validation environment removed those initial failures. One later reviewer run reported the same three failures; its subsequent run and the final main-agent verify passed without project edits. No separate investigation or fix of those unchanged tests was performed.

## Requirement evidence

| Requirement | Verification |
| --- | --- |
| FRQ-01 | Selection, replay, and extension tests exercise successful reads, skill commands, edited/omitted loads, retained suffixes, repeated compaction, equal summaries, malformed records, tree selection, reopening, and deterministic single insertion. Real AgentSession tests cover native and hook-based custom compaction; CLI checks cover single extension, package main, and package child replay. |
| FRQ-02 | Selection and shared path tests exercise listed directories, descendants/assets, leading-two-dot names, supported read path forms, outside paths, and previously tracked missing files. |
| FRQ-03 | Whole-file, partial, zero-room, exact-boundary, recency, changed-disk, deletion/reappearance, model, prompt, and tool tests. Final fake-provider Context observations cover preserved native content/sections/tools, later forced prompts, empty forced prompts, new-run reference replacement, active-run compaction/continuation, and the actual package system prompt. |
| FRQ-04 | Direct review of the system-prompt prose change. Tests assert behavior, structured metadata, estimates, configuration, and TUI results; no prompt-content assertions were added. |

Real CLI loading checks used temporary cwd/state, a fixture provider, --no-extensions, and temporary debug extensions. Fresh checks used --no-session; replay checks used isolated persisted sessions. Debug observers dumped before_agent_start.systemPrompt and active tools, then deliberately exited before provider dispatch. Prompt dumps were inspected as runtime data. Temporary state and debug extensions were removed.

## Review and corrections

CodeQuality, TextQuality, and Analyst reviewed each unit. The final whole-unit Analyst review approved UNT-03 after the budget correction. The main agent read the implementation and tests and independently ran full verification.

Review corrections include repaint-time renderer metadata, invalid selected-model settings handling, and complete final-system-head estimation. The latter uses public merged system state and the shared before_agent_start options reference. Later handlers update that same reference, so fitting follows Pi's actual native or forced-head branch. Provider-stage observers measure the final request independently of the production estimator's reconstructed input.

Original new-module tests recorded RED before implementation through absent-production-module failures. D9 revisions and subsequent corrections also have assertion-level RED/GREEN. Controlled mutation checks are recorded as sensitivity evidence, not historical TDD chronology.

## Approved changes and rejected additions

The user rejected the original content-bearing session records and D8 snapshots. D9 replaced them with paths only and fresh per-request disk reads. The fitting subset and contents can therefore change between requests. This was approved through O5-1 and reflected in the plan before implementation resumed.

D10 implements the existing complete-request budget contract through public APIs. It changes no dependency or storage format.

- Dual native/forced estimates: rejected. No basis for an additional conservative restriction after the exact public branch was identified; consequences without it are none. Gate-additions exit: NO CONSEQUENCES.
- A new Pi API/dependency change for the force flag: rejected. The shared public event reference already exposes the required state; consequences without the change are none. Gate-additions exit: NO CONSEQUENCES.
- Blanket historical assertion-level RED for every new module: rejected as an extra review condition absent from the original rules. Missing-module RED establishes pre-implementation chronology, while assertion sensitivity is distinguished explicitly.

No workaround, deprecation, dependency change, or new technical debt remains.

## Remaining limits and open questions

Per-request file reads add filesystem work. Missing or unreadable files are skipped while their paths remain tracked. Provider token accounting can differ from the shared o200k_base estimate. Provider cache hits and model compliance with the absent-file instruction remain external behavior. An absent-file list has an irreducible size and can exceed otherwise unavailable space when no file fits. consult-advisor retains canonical session replay and does not receive request-only restoration contents. Plain custom entries remain outside the subagent conversation screen.

No implementation question or unresolved user decision remains. The cause of the later transient agent-warning test failures was not investigated outside this task. Final user acceptance is pending.
