# Project check baseline

The authoritative baseline was collected by the main agent after rebase onto local `main` at `7e88dc9`, with feature HEAD `a487bbc`, before implementation.

| Command | Exit code | Result |
| --- | --- | --- |
| `bun run test` | 0 | Bun: 1839 passed, 1 skipped, 0 failed across 195 files. Go tests passed. |
| `bun run typecheck` | 0 | TypeScript emitted no diagnostics. |
| `bun run check` | 0 | Biome checked 431 files without fixes; gofmt and go vet passed. |

## Execution-context correction
Earlier baseline reports from SubAgentExtractor recorded three failures in `test/integration/agent-registry-warnings.test.ts`. Those reports used the collector's inherited Pi child-process environment and do not describe the normal project baseline. The main agent withdrew finding F1 after the user challenged the report.

The test subprocess copies `process.env`. The collector's environment contained `PI_AGENT_SUITE_CHILD_AGENT_PROCESS=1`, `PI_SUBAGENT_AGENT_ID=SubAgentExtractor`, depth, runtime lease, owner/root session identifiers, tool patterns, and workflow IDs. In `pi-package/extensions/main-agent-selection/index.ts`, `handleSessionStart` returns early when `isChildSubagentProcess` detects the inherited agent ID.

The main agent ran the focused test in both this workspace and the user's main checkout. Both passed all three cases, and their test files were byte-identical. The collector then repeated the focused test in a subprocess using a copied environment with `PI_SUBAGENT_*` and `PI_AGENT_SUITE_CHILD_AGENT_PROCESS` omitted. All three cases passed. The collector's parent environment and HOME were unchanged.

This correction changes the check execution method, not the product code or test expectations. Run subsequent full checks from the main process, or give a check subprocess an environment without the collector's child identity and policies. A report obtained under inherited collector markers is not a normal baseline.

## Dependency state
The rebased root package declares MCP client `^2.3.1`. At baseline collection, the installed client was `2.2.0` and installed Pi was `1.3.0`. At the UNT-01 text review, the installed client is `2.3.1`. Implementation validation uses lockfile-declared versions; dependency declarations and lockfiles remain unchanged.

## Open questions
None. The full normal-environment baseline passes. No waiver for existing test failures is needed.
