# Implementation checks

## UNT-01: Preserve custom prompts

### Behavior and tests
The ready-template handler reconciles active tools before returning no replacement for a truthy custom prompt. Absent and empty custom prompts still render the template. Runtime composition remains unchanged.

New fixture tests exercise both bundled and configured template sources, changed tool restrictions, selected-agent contributions, and the absent/empty boundary. The two preservation cases failed before the guard was added: focused RED had 13 passing and 2 failing tests. GREEN had 15 passing tests and no failures. The control cases retained existing behavior. No new test checks bundled prompt content.

### Project validation
After synchronizing declared dependencies with `bun install --frozen-lockfile --ignore-scripts`, the installed MCP client is `2.3.1`. Dependency declarations and lockfiles are unchanged.

The implementer, code reviewer, and final behavior reviewer each ran the project scripts with collector child markers omitted from a copied subprocess environment. Final reviewed results were:

| Command | Result |
| --- | --- |
| `bun run test` | Exit 0; 1843 passed, 1 skipped, 0 failed across 195 Bun files; Go tests passed. |
| `bun run typecheck` | Exit 0. |
| `bun run check` | Exit 0; Biome checked 431 files; gofmt and go vet passed. |
| `git diff --check` | Exit 0. |

The main agent read the complete code/test diff and the documentation changes. No runtime-composition, bundled-template, dependency, or lockfile change is included in this slice.

### Real Pi checks
The main agent repeated the pre-implementation probes with isolated temporary state, a fixture provider that throws if called, and a final debug before-agent-start handler. All four custom prompts were retained. Active-tool arrays matched the pre-implementation dumps exactly.

| Custom-prompt source | Custom prompt retained | Active tools |
| --- | --- | --- |
| CLI `--system-prompt` | Yes | read, bash, edit, write |
| Trusted-project `.pi/SYSTEM.md` | Yes | read, bash, edit, write |
| Agent-directory `SYSTEM.md` | Yes | read, bash, edit, write |
| Actual `convene_council` child | Yes | read |

The actual council tool was invoked through a temporary CLI command. Its RPC participant exited in the debug handler before a provider request, so no council answer was generated. The CLI parent completed after collecting the child result. No prompt was passed in offline mode.

The implementer separately checked CLI prompts with both bundled and configured templates, a selected-agent contribution, and a read-only tool allowlist. Both final dumps retained the custom prompt, Pi's cwd section, selected-agent contribution, and active tool `read`. Temporary state for those probes was removed.

### Reviews
SubAgentCodeQuality approved without corrections. SubAgentTextQuality corrected documentation wording and task status. SubAgentAnalyst found no in-scope mismatch with UNT-01 and FRQ-05/06. The main agent rejected the text review's longer README source list because the linked extension documentation already names each source and the specification requires a concise README row. The row retains only the custom-prompt exception. No behavior or requirement changed.

The code and overengineering gates pass: one required handler condition, fixture behavior tests, no new abstraction, fallback, configuration, or unrelated refactoring. Document corrections retain approved identifiers and exact fenced prompt wording.

## UNT-02: Render sections for the process role

### Behavior and tests
The extension captures the shared-marker process kind at construction. At template load, it validates role sections into ordered parts. At each agent turn, it selects common and matching-role parts before the existing variable substitution. Invalid section syntax retains Pi's prompt through the existing invalid-template path. The small section module contains the finite grammar and marker-line handling; the environment module reuses the shared classifier.

The fixture matrix covers both roles, common text, repeated inline sections, marker-only LF and CRLF lines, horizontal padding, final marker-only lines, substitution ordering, literal runtime markers, section-free bytes, and role capture across turns. Seven malformed fixtures cover unclosed, unmatched, mismatched, cross-kind and same-kind nested, and unknown opening and closing markers. No new test asserts bundled prompt content.

The implementer and code reviewer independently ran current tests against the UNT-01 implementation in temporary fixture trees: 17 tests failed. With UNT-02, all 34 focused tests passed. The two section-free compatibility controls already passed on UNT-01. Temporary RED fixture trees were removed.

### Project validation
After the code and text reviews, the main agent ran `bun run verify` directly in its normal environment. Exit code was 0: 1862 tests passed, 1 was skipped, and 0 failed across 195 Bun files, with 8565 assertions. Go tests, strict TypeScript, Biome, gofmt, and go vet passed. Biome checked 433 files without fixes. The skip is the pre-existing overflow-compaction retry test.

The implementer and code reviewer also ran the individual test, typecheck, and check scripts, full verify, and verify:ci successfully. The CI script's selected suite had 1823 passing tests and no failures. No dependency declaration, lockfile, new skip, or linter suppression changed.

### Real Pi checks
The main agent ran this matrix with isolated temporary state and final debug before-agent-start hooks. Each normal probe exited before a provider request. Fixture providers throw if called.

| Probe | Observed result |
| --- | --- |
| Single extension, main and child-marker processes | Both retain common rules; only main has conversation rules; only child has the defect block. |
| Whole package, main and child-marker processes | The same role distinction holds with package tool and prompt contributions. |
| Synthetic CRLF template, both roles | Exact role-specific fixture bytes and CRLF line endings are retained. |
| Configured role template plus child custom prompt | Pi's custom prompt is retained. |
| Unclosed section fixture | Pi's prompt is retained; the malformed template body is absent. |
| Actual run-subagent worker | Shared child marker and agent ID are present; common/child rules and the fixture agent contribution are present; goal guard and user communication are absent; only `read` is active. |
| CLI, trusted-project SYSTEM.md, agent-directory SYSTEM.md | Each custom prompt is retained with `read`, `bash`, `edit`, and `write` active. |
| Actual council participant | The participant custom prompt is retained; only `read` is active. |

The actual run-subagent probe explicitly loaded the target package before the debug extension so the final hook observed package transformations. The worker exited in that hook; the parent recorded the expected startup interruption. The council probe used the actual registered tool and RPC child. Neither probe requested a real model response. No prompt was passed in offline mode.

### One-time bundled comparison
The main agent compared the rendered main-agent prompt with its pre-implementation runtime dump in the same temporary cwd and tool configuration. Replacing only the baseline scope-control rule 3 with the exact PRD replacement made the strings byte-identical: 13477 UTF-8 bytes. This verifies NRQ-01 on actual runtime output.

The implementer separately selected the bundled template through the production parser and selector. Main text equaled baseline with only the exact PRD rule substitution, at 12826 bytes. Child text equaled baseline common text with goal guard and user communication removed and scope control replaced by the exact PRD child block, at 3453 bytes. The text reviewer separately verified both mandated blocks against the PRD. These were one-time manual checks, not committed prompt-content tests.

### Reviews
SubAgentCodeQuality found no new in-scope issue and reproduced RED/GREEN and passing root scripts. SubAgentTextQuality clarified documentation, declaration comments, and stale task status without changing code behavior or approved prompt wording. SubAgentAnalyst found no in-scope mismatch; its fresh focused check passed all 34 tests and independent verification reproduced RED and passed verify. The main agent read the complete code/test diff and accepted the reviewed changes.

Code, document, and overengineering gates pass for the new behavior. The implementation adds no dependency, configuration flag, general-purpose template engine, duplicate common template, fallback, or unrelated refactoring. F2 and F3 remain unchanged outside the task.

## User-authorized follow-up findings

The user requested correction of F2 and F3 after the original implementation report. D11 and UNT-03/04 record this scope extension.

### F2: Bundled-content test, resolved in UNT-03
Before UNT-03, `places bundled toolsets between skills and tool guidelines` in `pi-package/extensions/system-prompt/index.test.ts` asserted bundled marker presence and ordering. This conflicted with project testing rule 5. The original finding was based on static inspection, without a marker-changing experiment.

UNT-03 replaces that test with `inserts dynamic toolsets between fixture-defined surrounding text`. It writes an isolated synthetic template containing literal text around `{{toolsets}}`, configures the real handler to use it, and compares the complete dynamic output with the fixture-defined expected string. Bundled prompt content and production code are unchanged.

The focused suite passed all 34 tests before and after the test-only refactor. The main agent ran `bun run verify` after the last comment correction: exit 0, 1862 passed, 1 existing skip, 0 failures, 8563 assertions; Go tests, strict TypeScript, Biome, gofmt, and go vet passed. Code, text, and behavior reviews found no unresolved in-scope issue. No new production behavior or artificial RED change was introduced.

### F3: Existing README code fence
When a reader views the context-projection configuration examples, the full-example label and opening fence belong to the preceding code block. `README.md`, context-projection minimum configuration example, opens a JSON fence and has no closing fence before the full-example label. Expected documentation has separate fenced minimum and full examples. Proposed correction: close the minimum-example fence. This was checked from source and Markdown fence grammar; rendered-page behavior was not reproduced. The user authorized the missing-fence correction in D11; UNT-04 is pending. Before correction, the already installed Markdown parser produces one JSON code token containing the full-example label and no separate paragraph for that label.

## Open questions
None within the implementation scope. The feature units and UNT-03 passed their checks and reviews. The authorized F3 correction remains pending in UNT-04.
