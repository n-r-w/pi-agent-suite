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

## Separate findings outside the task

### F2: Existing bundled-content test
When a developer changes bundled template markers or their placement, the test `places bundled toolsets between skills and tool guidelines` can fail even if rendering logic is unchanged. It asserts marker presence and ordering in `pi-package/extensions/system-prompt/index.test.ts`. Project testing rule 5 requires logic-only tests. Proposed correction: exercise placement with a synthetic template fixture. The finding is based on static inspection; no marker-changing experiment was run. The existing test is unchanged by UNT-01. Further investigation and modification require user approval.

### F3: Existing README code fence
When a reader views the context-projection configuration examples, the full-example label and opening fence belong to the preceding code block. `README.md`, context-projection minimum configuration example, opens a JSON fence and has no closing fence before the full-example label. Expected documentation has separate fenced minimum and full examples. Proposed correction: close the minimum-example fence. This was checked from source and Markdown fence grammar; rendered-page behavior was not reproduced. The example is unchanged by this task. Further investigation and modification require user approval.

## Open questions
None within the implementation scope. UNT-02 remains planned. Separate findings F2 and F3 are reported without authorization to change them.
