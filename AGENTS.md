# AGENTS.md

Guidance for coding agents working in this repository.

## Project purpose

1. This repository contains one local pi package for custom pi extensions.
2. The package is loaded through the `packages` key in `settings.json`.

## General Rules
1. ALL documentation and code comments must be in English.
2. Strictly follow best practices for ts coding, testing, and package management.
3. Follow best practices for pi extension development, don't reinvent the wheel.
4. If open questions arise during coding that do not have a clear answer, stop immediately and ask the user for clarification.
5. Keep documentation in `docs/extensions` up to date.

## Project scope

Target extensions are:

- `main-agent-selection`
- `run-subagent`
- `consult-advisor`
- `codex-verbosity`
- `codex-quota`
- `custom-compaction`
- `footer`

1. Keep extension ownership clear:
  1) `main-agent-selection` owns main-agent selection.
  2) `run-subagent` owns subagent execution.
  3) `consult-advisor` owns advisor behavior.
2. Keep shared modules narrow:
  1) Agent registry.
  2) Tool policy.
  3) Runtime prompt and active-tool composition.
3. Do not add compatibility wrappers, fallback reads, duplicate config reads, or temporary adapters unless the user explicitly approves that behavior.

## Architecture rules

1. `Agent Runtime Composition` owns final prompt and active-tool composition for agent-related extensions.
2. Extension entry points publish their own contribution and must not compete over final prompt or active tools.
3. Extension load order must not change final agent prompt behavior or final active-tool behavior.
4. State ownership must stay explicit. Do not write unrelated runtime data into selected-agent state.
5. Configuration ownership must stay isolated. A configuration error in one extension must not break another extension.

## Configuration and state rules

1. Extension configuration lives under `~/.pi/agent/config`.
2. Selected-agent state stays under `~/.pi/agent/agent-selection/state/`.

## Package rules

1. Use a pi package structure with explicit extension entry points in `package.json`.
2. Keep entry points small. Put shared behavior in shared modules only when more than one extension needs it.
3. Put imported pi runtime packages in `peerDependencies`.
4. Add runtime dependencies only when code imports them at runtime.
5. Validation tools used by package scripts must be project-owned dependencies, not global CLI assumptions.
6. Do not add package sources that create duplicate extension loading.

## Testing rules

1. Use RED-GREEN-REFACTOR for behavior changes:
  1) RED: add or update a failing behavior test.
  2) GREEN: implement the smallest behavior-preserving change that passes the test.
  3) REFACTOR: simplify without changing behavior.
2. Use Bun as the test runner.
3. Tests must use isolated fixtures and fakes instead of real user files, real auth, real models, real network calls, or real git state.
4. Prefer tests that prove observable extension behavior over tests that only prove folder names or formatting.
5. Add integration checks only where unit tests cannot prove package loading, single registration, or child `pi` behavior.

## Test layout rules

1. Use Bun-discoverable test file names: `*.test.ts` by default.
2. Put unit tests next to the code they cover:
  1) Extension entry point tests live at `extensions/<extension>/index.test.ts`.
  2) Extension internal module tests live at `extensions/<extension>/<module>.test.ts`.
  3) Shared module tests live at `shared/<module>.test.ts`.
3. Put shared test helpers under `test/support/`.
4. Put static test fixtures under `test/fixtures/`.
5. Put integration checks under `test/integration/*.test.ts`.
6. Do not use `__tests__` directories by default.
7. Use a `__tests__` directory only when all conditions are true:
  1) The tests cover the public contract of a whole module or package area instead of one source file.
  2) Co-located `*.test.ts` files would make the source directory hard to scan.
  3) The files inside `__tests__` still use Bun-discoverable names such as `*.test.ts`.
8. Tests for one extension must not import another extension entry point.
9. Load multiple extension factories only in tests that verify cross-extension composition, package loading, or load-order behavior.
10. Temporary files in tests must be created through helpers that write only to system temporary directories.

## Validation rules

1. Use package scripts for validation:
  1) `bun run test` for behavior tests.
  2) `bun run typecheck` for type checks.
  3) `bun run check` for linting and formatting checks.
  4) `bun run verify` for full validation.
2. TypeScript work must pass the strict compiler settings configured in `tsconfig.json`.
3. Do not weaken validation or compiler settings to make code pass. Fix code or ask for a scope decision.
4. Use `biome check . --write` only for intended formatting and safe lint fixes.
5. Run relevant behavior tests, `bun run typecheck`, and `bun run check` before completing a phase that changes code.
6. If a required validation command cannot run, report the command, failure reason, impact, and next resolving step.
7. pi specific validation:
  1) Use `pi --no-session -p -e ./extensions/<extension>/index.ts` to validate single extension loading.
  2) Use `--no-extensions` to isolate package loading from globally configured extensions.
  3) Use `--offline` only for checks that do not require an LLM provider response. It validates extension startup only and does not validate provider response.
  4) Do not treat `--offline` timeouts from prompt-driven checks as extension failures when the check needs model output.
  5) Use `pi --no-session -p -e .` to validate whole-package loading.
8. For live checks of tool, agent, prompt, or active-tool availability, run the real `pi` CLI with the target package, a temporary cwd/state when needed, and a temporary debug extension that dumps `before_agent_start.systemPrompt` and `pi.getActiveTools()`. Inspect the dumped runtime data, not only unit-test fakes, and remove temporary state after the check.

## Release safety rules

1. Treat changes to local pi loading sources as operational release work.
2. Do not modify global or project pi settings without explicit user approval.
3. Before changing loading sources, check for duplicate package or extension loading paths.
4. Keep failure recovery as an operational procedure, not as permanent compatibility logic in code.

## Security and side effects

1. Pi packages and extensions run with full system permissions.
2. Review package source, manifest entries, and runtime dependencies before adding them to settings.
3. Do not read or modify real user config, auth files, prompt files, extension directories, or pi settings during tests.
4. Git commands that change repository state, user settings, or global pi configuration require explicit user approval.
