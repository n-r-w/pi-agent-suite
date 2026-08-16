# AGENTS.md

## Project purpose

Custom `pi.dev` extensions: `pi-package/extensions/*`

## General Rules
1. ALL documentation and code comments must be in English.
2. Follow best practices for pi extension development, don't reinvent wheel.
3. If open questions arise during coding that do not have a clear answer, stop immediately and ask user for clarification.
4. Keep files small and readable. Avoid giant dump files.
5. Suppressing linter warnings is prohibited without user approval.

## Consistency rules
1. All extensions should use a unified logic when working with:
    1) TUI: custom rendering, consistent on both main screen and subagent screen; compact and full rendering (ctrl+o).
    2) Models: aliases, setting thinking level
2. Before reinventing wheel, ALWAYS look for existing patterns!

## Project Documentation
1. Put documentation for new features in `docs/specs/features/{feature-name}/*`
2. Put documentation for bugs in `docs/specs/issues/{issue-name}/*`
3. Each new feature/bug must have a separate directory
4. Keep extension documentation in `docs/extensions/*` up to date.
5. `README.md` files should be concise. All details in `docs/extensions/*`.

## Testing rules
1. Use RED-GREEN-REFACTOR for behavior changes:
    1) RED: add or update a failing behavior test.
    2) GREEN: implement smallest behavior-preserving change that passes test.
    3) REFACTOR: simplify without changing behavior.
2. Use Bun as test runner.
3. Tests must use isolated fixtures and fakes instead of real user files, real auth, real models, real network calls, or real git state.
4. Add integration checks only where unit tests cannot prove package loading, single registration, or child `pi` behavior.
5. MANDATORY RULE: Tests that check contents of prompts should MUST check text that is EXPLICITLY used in logic and NEVER text that can change arbitrarily.

## Test layout rules
1. Use Bun-discoverable test file names: `*.test.ts` by default.
2. Put unit tests next to code they cover:
    1) Extension entry point tests live at `extensions/<extension>/index.test.ts`.
    2) Extension internal module tests live at `extensions/<extension>/<module>.test.ts`.
    3) Shared module tests live at `shared/<module>.test.ts`.
3. Put shared test helpers under `test/support/`.
4. Put static test fixtures under `test/fixtures/`.
5. Put integration checks under `test/integration/*.test.ts`.
6. Do not use `__tests__` directories by default.
7. Tests for one extension must not import another extension entry point.
8. Temporary files in tests must be created through helpers that write only to system temporary directories.

## Validation rules
1. Use package scripts for validation:
    1) `bun run test` for behavior tests.
    2) `bun run typecheck` for type checks.
    3) `bun run check` for linting and formatting checks.
    4) `bun run verify` for full validation.
2. TypeScript work must pass strict compiler settings configured in `tsconfig.json`.
3. Use `biome check . --write` only for intended formatting and safe lint fixes.
4. pi specific validation:
    1) Use `pi --no-session -p -e ./extensions/<extension>/index.ts` to validate single extension loading.
    2) Use `--no-extensions` to isolate package loading from globally configured extensions.
    3) Use `--offline` only for checks that do not require an LLM provider response. Prompt passing is PROHIBITED in offline mode.
    4) Use `pi --no-session -p -e .` to validate whole-package loading.
5. For live checks of tool, agent, prompt, or active-tool availability, run real `pi` CLI with target package, a temporary cwd/state when needed, and a temporary debug extension that dumps `before_agent_start.systemPrompt` and `pi.getActiveTools()`. Inspect dumped runtime data, not only unit-test fakes, and remove temporary state after check.

## Pi Documentation
1. /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/README.md
2. /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/
3. /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/README.md

## Pi Source Code
/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist