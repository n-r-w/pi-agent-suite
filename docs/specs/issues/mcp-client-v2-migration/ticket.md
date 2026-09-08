# Ticket TKT-01: Migrate the MCP wrapper to TypeScript SDK v2

Replace the monolithic MCP SDK with its dedicated v2 client package. Verify the dependency tree that users receive during installation and upgrade, not only the repository lockfiles.

## Key definitions and abbreviations

- MCP: Model Context Protocol, used by the extension to discover and call server tools.
- Candidate package: The npm archive built from the project revision under test.
- Consumer fixture: An isolated temporary npm project that installs the candidate package as a dependency.

## Problem statement

The project declares `@modelcontextprotocol/sdk@^1.30.0`. The wrapper uses its client implementation, but the SDK also installs server dependencies through `express → body-parser → qs`.

After upgrading to `pi-agent-suite@2.8.0`, an existing Pi installation retained `qs@6.15.3` and reported one moderate vulnerability. The Express and body-parser dependency ranges permit that version. Updating the repository lockfiles to `qs@6.16.0` did not prevent this result because npm does not use a dependency's `package-lock.json` to constrain the consumer installation.

The repository audit passed against its updated lockfile. RPC tests, type checks, lint checks, and package dry runs did not exercise the consumer upgrade path.

## Target picture

The wrapper uses the dedicated MCP v2 client without pulling the v1 server dependency chain into the published package's production dependencies. Users install or upgrade the package without a separate dependency repair command for the reported vulnerabilities. Release checks exercise both consumer scenarios and report audit failures before release preparation succeeds.

## Scenarios

### SCN-01: Discover and call tools

- Actor: A Pi user with configured MCP servers.
- Pre-condition: An isolated server fixture exposes tools over either supported transport.
- Trigger: Pi starts discovery or the user invokes a generated tool.
- Required behavior: The wrapper connects, discovers all tool pages, forwards call arguments and request options, and maps results and failures to its public contract.
- Example input and expected output: A server exposes `echo`; a call with `{"text":"hello"}` produces the server's text result `hello`. Two discovery pages produce both tools exactly once.

### SCN-02: Install the candidate package

- Actor: A user installing the project for the first time.
- Pre-condition: A consumer fixture has no previous project installation.
- Trigger: The candidate archive is installed using the npm dependency policy used by Pi.
- Required behavior: Installation succeeds, the extension loads, and the installed production dependency audit passes without a repair command.
- Example input and expected output: Installing the candidate archive and auditing at the consumer root produces audit exit code 0 at the project's low-severity threshold.

### SCN-03: Upgrade an installation with the reported vulnerability

- Actor: A user upgrading an existing project installation.
- Pre-condition: A consumer fixture reproduces `pi-agent-suite@2.8.0` with the installed and locked transitive dependency `qs@6.15.3`.
- Trigger: The candidate archive replaces the installed project version through the normal installation command.
- Required behavior: The upgrade succeeds and the resulting production dependency audit passes without clearing state, deleting the consumer lockfile, or running a repair command.
- Example input and expected output: Before the upgrade, the fixture audit identifies vulnerable `qs`; after the upgrade, the audit exits with code 0 at the low-severity threshold.

## Scope

In scope:
- Migrate the wrapper's client dependency and SDK adapter to v2.
- Adapt affected tests and dependency declarations in both project manifests.
- Synchronize the three tracked lockfiles and remove overrides made obsolete by this migration.
- Add repeatable release checks for SCN-02 and SCN-03.
- Update the extension and publishing documentation to describe the resulting dependency and validation contracts.

Out of scope:
- Implementing an MCP server or adding transports, authentication flows, or protocol features.
- Redesigning tool rendering, configuration, caching, or on-demand activation.
- Requiring users to repair their npm installation manually.
- Introducing a published shrinkwrap, a direct `qs` dependency, or installation scripts that mutate the consumer's dependencies.
- Unrelated dependency upgrades, publishing a release, or changing global Pi installations.

## Dependencies and preconditions

- npm registry metadata identifies `@modelcontextprotocol/client@2.0.0` as the stable target. Its mandatory dependency tree does not include the Express chain used by SDK v1.
- The SDK migration guide documents incompatible API and behavior changes. The implementation must evaluate the wrapper's actual calls against that guide.
- Consumer installation and audit checks need access to the npm registry and audit service. They are release checks, separate from deterministic Bun behavior tests.

## Requirements

### Goals

- Remove the unnecessary server dependency chain responsible for the reported consumer audit failure.
- Retain the wrapper's tool discovery and invocation behavior with the dedicated v2 client.
- Detect consumer installation and upgrade failures before release preparation succeeds.

### Functional requirements

- FRQ-01: When Pi uses the wrapper, the wrapper shall use the dedicated v2 MCP client for both stdio and Streamable HTTP connections.
  - Goal: Remove the unnecessary server dependency chain.
  - Goal achievement: Full. The wrapper no longer requires the monolithic v1 SDK.
- FRQ-02: When discovery or a tool call runs, the wrapper shall preserve configured process arguments, environment additions, working directory, HTTP headers, cancellation, timeouts, pagination results, result mapping, error propagation, and connection cleanup.
  - Goal: Retain tool discovery and invocation behavior.
  - Goal achievement: Full. Tests exercise successful calls, multiple discovery pages, cancellation, timeout, server errors, and closure for both transports without testing prompt content.
- FRQ-03: When release installation checks run, they shall install the candidate archive in separate clean and upgrade consumer fixtures and audit the resulting production dependencies at the consumer root.
  - Goal: Detect consumer dependency failures.
  - Goal achievement: Full. SCN-02 and SCN-03 must each finish with successful installation and audit exit code 0.
- FRQ-04: When a consumer installation or audit check fails, release preparation shall fail before changing the package version and shall identify the failing scenario.
  - Goal: Prevent a repository-only audit from approving a failing consumer installation.
  - Goal achievement: Full. A failing fixture check produces a nonzero release-check exit status and leaves the version unchanged.

### Non-functional requirements

- NRQ-01: Behavior tests shall use isolated fixtures and fakes rather than user configuration, credentials, live MCP servers, model providers, or real git state. Package installation checks shall use system temporary directories and leave the user's Pi installation unchanged.
  - Goal: Make verification safe and repeatable.
  - Goal achievement: Full. The checks require no user state and clean up their temporary state on success and failure.
- NRQ-02: The candidate shall pass the repository's full validation, repository audit, consumer installation audits, and isolated Pi package-loading check. Audit thresholds shall not be weakened or warnings suppressed.
  - Goal: Verify runtime compatibility and the reported security failure.
  - Goal achievement: Full. Completion evidence includes commands, exit codes, audit summaries, and behavior-test results.

## Overengineering and overspecification considerations

This ticket covers one end-to-end dependency migration, including its consumer installation contract. Reuse the SDK transports, wrapper boundaries, and existing test helpers. Do not add a compatibility layer, custom JSON-RPC client, or general dependency-management framework.

## Constraints and risks

- SDK v2 changes call signatures and some list behavior. Updating import paths alone can leave runtime errors hidden behind injected constructor interfaces and fakes.
- Other packages in a consumer environment can independently install SDK v1 or vulnerable dependencies. The acceptance fixtures contain this project and the host prerequisites needed to reproduce Pi installation, not unrelated user packages.
- Security advisories change over time. A new audit finding is a release blocker to investigate, not evidence that audits should be disabled or that this migration guarantees permanent vulnerability-free installations.

## Assumptions

- This project needs an MCP client, not the SDK's server implementation. The wrapper currently imports only `Client`, `StdioClientTransport`, and `StreamableHTTPClientTransport`; verify all SDK references before removing v1.

## Open questions

None at ticket creation. Newly discovered API or host dependency conflicts require a scope decision before introducing a workaround.

## Technical supplement

### Migration boundary

- Update `package.json` and `pi-package/package.json` from `@modelcontextprotocol/sdk@^1.30.0` to `@modelcontextprotocol/client@^2.0.0`.
- Adapt `pi-package/extensions/mcp-wrapper/sdk-client-factory.ts` and its constructor interfaces to the published v2 types. The v1 adapter currently calls `client.callTool(params, undefined, options)`; verify the v2 options position explicitly.
- Check SDK v2 list aggregation against the wrapper's cursor pagination so tools are neither omitted nor duplicated.
- Synchronize `bun.lock`, `pi-package/bun.lock`, and `pi-package/package-lock.json`. Do not assume changing those files constrains downstream consumers.
- Start with the existing adjacent MCP wrapper tests. For behavior changes, demonstrate a failing behavior assertion before the implementation change and a passing assertion afterward. Do not add tests that only inspect dependency strings or prompt text.

### Release verification

- Build an actual npm archive rather than relying on `npm pack --dry-run`.
- Derive the installation command and peer dependency handling from the supported Pi package manager. Do not use a different npm policy merely to make the fixture audit pass.
- Reconstruct the upgrade fixture from a controlled manifest and lockfile, not the developer's global installation. Verify the installed baseline contains `qs@6.15.3` before upgrading.
- Audit with `npm audit --omit=dev --audit-level=low` at each consumer root. The baseline must reproduce the reported finding; the candidate installations must pass.
- Run `bun run verify` and `make audit`. Run an isolated real Pi package-loading check with no user state or provider request. Do not pass a prompt in offline mode.
- Verify the published package's own mandatory dependency tree no longer brings in SDK v1's Express chain. Distinguish it from host peer dependencies in the report.

## References

- [SDK v2 migration guide](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.html): API, packaging, and behavior changes.
- [MCP client package](https://www.npmjs.com/package/@modelcontextprotocol/client): Published client package and versions.
- [npm package-lock documentation](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json): Lockfile behavior outside the root project.
- [qs array-limit advisory](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx): One reported vulnerability affecting the retained dependency.
- [qs isBuffer advisory](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g): Reported denial-of-service vulnerability fixed in `qs@6.16.0`.
- `docs/extensions/mcp-wrapper.md`: Wrapper configuration and behavior contract.
- `docs/PUBLISHING.md` and `Makefile`: Publication workflow and release checks.
