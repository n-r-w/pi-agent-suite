# Technical solution: Subagent extension loading

## Problem statement

See [Problem statement](problem.md) and [Requirements](prd.md).

## Proposed solution

### Configuration boundary

The run-subagent extension reads the suite-owned agent-selection configuration during extension initialization. It validates the extension-loading section and converts the selection into Pi CLI arguments. Missing configuration uses ordinary extension discovery. Invalid JSON, unreadable configuration, unsupported keys, and invalid mode or list values reject extension loading with the configuration location in the diagnostic.

The existing main-agent `enabled` field is accepted without changing main-agent selection behavior. The legacy main-agent configuration fallback does not supply the subagent setting.

### Worker loading

The root runtime keeps the resolved extension arguments for its lifetime. Its supervisor applies those arguments whenever it creates a worker, including nested delegation and continuation of a completed session. Active steering reuses the existing worker.

- `none` disables discovery and explicitly loads the required package.
- `all` keeps ordinary Pi extension discovery and explicitly loads the required package.
- `explicit` disables discovery, explicitly loads the selected sources, and explicitly loads the required package.

Pi owns source resolution and registration. Relative paths resolve against the child's project working directory. Built-in extension identifiers follow Pi's `-e builtin:<name>` behavior.

### Tool availability

The child resolves its existing tool policy against the registered tool catalog. Loading an extension does not grant permission to use every tool it registers. A tool pattern that matches no registered tool retains the existing launch-failure behavior.

### Verification

Unit tests exercise configuration validation and the registered `subagent_start` entry point with a fake process boundary. Argument tests cover new and resumed session selection. Real Pi loading checks use isolated project and agent state, capture runtime tool catalogs and active tools, and verify single package registration in each mode. A temporary debug extension captures the runtime system prompt without asserting prompt content or calling a provider.

## Overengineering and overspecification considerations

The change uses Pi's existing extension loader and the package's existing suite-storage and validation helpers. It adds no extension discovery implementation, dependency, per-agent override, blacklist, or additional configuration file.

The default changes from package-only loading to ordinary Pi extension discovery. Users who need the package-only behavior select `none` explicitly.

## Open questions

None.

## References

- `pi-package/extensions/run-subagent/extension-config.ts`: configuration boundary.
- `pi-package/extensions/run-subagent/index.ts`: runtime policy ownership.
- `pi-package/extensions/run-subagent/invocation-process.ts`: Pi worker arguments.
- `test/integration/subagent-extensions.test.ts`: real Pi registration and tool-policy checks.
