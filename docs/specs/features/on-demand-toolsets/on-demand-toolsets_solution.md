# Technical Solution: On-Demand Toolsets

## Problem Statement

- **PRB-01:** `mcp-wrapper` registers all discovered MCP tools as active, causing unrelated tool definitions to enter model-provider requests.
- **PRB-02:** Deferred tools must remain discoverable through compact triggers without bypassing the tool restrictions of the current independent pi session.
- **CNS-01:** Main, child, and recursively nested child agents run independent pi sessions with separate `ExtensionAPI`, history, tool policy, and activation state.

## Proposed Solution

### Architecture

- **DEC-01:** Add a generic per-`ExtensionAPI` toolset runtime under `pi-package/shared/toolsets/`.
- **DEC-02:** Do not create a separate extension entry point. The first registered tool provider initializes the runtime.
- **DEC-03:** `mcp-wrapper` registers deferred MCP servers as toolsets after their metadata is loaded.
- **DEC-04:** `system-prompt` obtains the visible trigger catalog from the shared runtime when expanding `{{toolsets}}`.
- **DEC-05:** Extend `AgentRuntimeComposition` instead of introducing a competing owner of `pi.setActiveTools()`.

### Components

- **CMP-01:** `shared/toolsets/contracts.ts` defines toolset metadata, provider registration, activation results, and persisted state details.
- **CMP-02:** `shared/toolsets/runtime.ts` owns provider registrations, activation state, the `activate_toolset` definition, history reconstruction, and the deferred tool filter.
- **CMP-03:** `shared/toolsets/rendering.ts` renders activation calls and results using Pi’s default tool shell.
- **CMP-04:** `shared/agent-runtime-composition.ts` owns the unfiltered session tool baseline, the resolved current-agent restriction, ordered named filters, and the final active tool set.
- **CMP-05:** `mcp-wrapper` remains responsible for MCP configuration, metadata discovery, cache refresh, generated tool definitions, MCP instructions, calls, and results.
- **CMP-06:** `system-prompt` remains the sole owner of template-variable parsing and replacement.

### Per-session isolation

- **SOL-01:** The toolset runtime uses the same per-`ExtensionAPI` WeakMap and event-bus holder pattern as `AgentRuntimeComposition`.
- **SOL-02:** Each main, child, and nested-child pi session receives a separate runtime because each has its own `ExtensionAPI`.
- **SOL-03:** Activation state is never inherited or synchronized between parent and child sessions.

### Tool availability composition

- **SOL-04:** `AgentRuntimeComposition` computes candidates in this order:
  1. session baseline established by Pi and `enable-tools`;
  2. the tool list resolved for the current main or child agent;
  3. current nested-depth restrictions;
  4. deferred-toolset filtering.
- **APC-01:** Named filters accept a candidate list and may only remove names. The composition intersects filter output with filter input so a filter cannot grant tools.
- **APC-02:** The composition exposes operations to update the session baseline, set or clear the current-agent tool list, register or remove a named filter, and reconcile `pi.getActiveTools()`.
- **SOL-05:** `main-agent-selection`, child policy application, and `enable-tools` update the composition rather than leaving competing final calls to `pi.setActiveTools()`.
- **SOL-06:** The toolset filter runs after agent and depth restrictions. It records the pre-deferred tool names needed to determine which triggers are visible.
- **SOL-07:** Activating a toolset removes only its deferred restriction. It never adds a name absent from the pre-deferred candidate list.
- **SOL-08:** Reconciliation runs after session setup, agent selection changes, child policy application, MCP catalog replacement, and successful activation. The existing `before_agent_start` reconciliation remains a final safety check.

### MCP configuration

- **CFG-01:** Both stdio and streamable HTTP server objects accept:
  ```json
  {
    "onDemand": {
      "name": "github",
      "description": "Activate for GitHub repository operations."
    }
  }
  ```
- **CFG-02:** Absence of `onDemand` retains eager behavior.
- **CFG-03:** `onDemand` accepts exactly `name` and `description`.
- **CFG-04:** Both values must contain at least one non-whitespace character and must not contain leading or trailing whitespace.
- **CFG-05:** `onDemand.name` values use exact, case-sensitive identity and must be unique across `mcpServers`.
- **FLR-01:** Any configuration violation returns the existing invalid-config result. `handleSessionStart` displays a warning and leaves `mcp-wrapper` disabled without preventing pi startup.
- **SOL-09:** `computeMcpServerConfigHash` hashes only transport and connection identity fields. Changing `onDemand.name` or `onDemand.description` does not invalidate cached MCP metadata.

### MCP startup and registration

- **STP-01:** Preserve startup cache loading, discovery of missing metadata, cache persistence, and background refresh.
- **STP-02:** Build and register Pi tool definitions for eager and deferred servers whose metadata is available.
- **STP-03:** Add all registered definitions to the composition baseline before applying current-agent and toolset filters.
- **STP-04:** Register an MCP toolset only when metadata contains its discovered tool list.
- **FLR-02:** A deferred server without loaded metadata has no toolset record, trigger, or activation route. Existing MCP startup diagnostics report the metadata failure.
- **STP-05:** A successful `/mcp-refresh` reloads runtime state through the established reload path. Newly available metadata creates the toolset during the replacement session.
- **SOL-10:** Eager servers never enter the deferred registry and retain their existing generated definitions, MCP instructions, call routing, result mapping, and presentation.
- **SOL-11:** Deferred MCP instructions remain absent because the existing instruction handler already emits instructions only for active generated tool names.

### Generic provider contract

- **ENT-01:** A registered toolset contains:
  - provider identifier;
  - exact toolset name;
  - activation description;
  - loaded tool names;
  - provider activation operation.
- **APC-03:** Provider registration replaces that provider’s previous session-local catalog atomically.
- **APC-04:** The activation operation returns the loaded tool names available for composition. The MCP implementation does not introduce an extra network connection and preserves standard MCP connection behavior.
- **APC-05:** Runtime commits activation state only after provider activation and active-tool reconciliation succeed.
- **FLR-03:** Provider or reconciliation failure rolls back the pending activation, returns an error, keeps the trigger visible, and permits retry.

### Activation tool

- **APC-06:** Register one package tool named `activate_toolset`.
- **APC-07:** Use a required parameter equivalent to:
  ```ts
  Type.Object(
    {
      name: Type.String({
        minLength: 1,
        description: "Exact case-sensitive toolset name from <toolsets>.",
      }),
    },
    { additionalProperties: false },
  )
  ```
- **APC-08:** Use this LLM-visible description:
  ```text
  Activate a toolset listed in <toolsets> when its tools are needed.
  ```
- **SOL-12:** The composition keeps `activate_toolset` active only when:
  - the current agent’s resolved tool list contains `activate_toolset`; and
  - at least one deferred toolset contains a tool present before deferred filtering.
- **FLR-04:** Empty `name` fails JSON Schema validation.
- **FLR-05:** A non-empty unknown name returns a tool error without changing activation state.
- **SOL-13:** Repeated activation of an active name succeeds without changing state.

### Session-history state

- **EVC-01:** Every successful activation stores a versioned full snapshot in `toolResult.details`:
  ```ts
  {
    version: 1,
    activeToolsets: ["github", "database"],
  }
  ```
- **ALG-01:** On `session_start`, scan `ctx.sessionManager.getBranch()` for successful `activate_toolset` results with valid details and restore the last valid snapshot.
- **ALG-02:** Branching or rewinding naturally selects the last snapshot present in the active branch.
- **FLR-06:** Unknown versions or malformed details are ignored rather than interpreted.
- **FLR-07:** Snapshot names absent from the loaded configuration produce a warning and are ignored. The valid current configuration remains active.
- **SOL-14:** Activation snapshots remain session-local and are not written to global configuration or cache files.

### `{{toolsets}}` macro

- **APC-09:** Add `toolsets` to `SUPPORTED_TEMPLATE_VARIABLES`.
- **APC-10:** `buildTemplateValues` obtains visible deferred toolsets from the runtime associated with the handler’s `ExtensionAPI`.
- **APC-11:** Before rendering, `system-prompt` requests active-tool reconciliation and uses the reconciled active names for tool-dependent template values.
- **APC-12:** No visible toolsets produce an empty string.
- **APC-13:** Visible entries produce:
  ```xml
  <toolsets>
  <toolset name="github" description="Activate for GitHub repository operations."/>
  </toolsets>
  ```
- **SOL-15:** XML attribute values escape `&`, `<`, `>`, `"`, and `'`.
- **SOL-16:** The bundled system template adds `{{toolsets}}` between the skills catalog and the active-tools section.
- **SOL-17:** Custom templates receive no triggers unless they contain `{{toolsets}}`.

### LLM result and TUI rendering

- **APC-14:** First activation returns LLM content containing status followed by every tool name made available to the current agent:
  ```text
  Activated toolset "github".
  Available tools:
  - github_create_issue
  - github_get_issue
  ```
- **APC-15:** Repeated activation returns `already active` status followed by the complete currently available tool-name list.
- **APC-16:** LLM content contains no tool parameters or individual tool descriptions.
- **SOL-18:** `renderCall` uses a compact, width-bounded toolset name inside Pi’s default tool shell.
- **SOL-19:** Collapsed `renderResult` shows status, tool count, the first bounded tool-name lines, and the standard `ctrl+o` hidden-content hint.
- **SOL-20:** Expanded `renderResult` uses Pi `Text` to show the complete tool-name list.
- **SOL-21:** Both main and subagent screens use the same registered tool definition and renderer.

### Testing strategy

- **TSK-01:** Add failing configuration tests for `onDemand`, unsupported keys, whitespace-only values, surrounding whitespace, and duplicate case-sensitive names.
- **TSK-02:** Add shared runtime tests for per-`ExtensionAPI` isolation, provider replacement, unknown names, idempotent activation, atomic rollback, and visibility of `activate_toolset`.
- **TSK-03:** Add history tests for snapshot restoration, branch rewind, malformed details, unknown versions, and stale configured names.
- **TSK-04:** Extend composition tests for ordered restrictive filters and prove that no filter can add tools.
- **TSK-05:** Add main, child, nested-depth, and `enable-tools` composition tests proving that activation never overrides agent restrictions.
- **TSK-06:** Add `mcp-wrapper` tests proving deferred definitions are registered but inactive, eager tools remain active, metadata failures create no trigger, MCP instructions appear only after activation, and cache hashing ignores `onDemand`.
- **TSK-07:** Add `system-prompt` tests for supported `{{toolsets}}`, empty expansion, XML escaping, custom-template omission, and the bundled macro position.
- **TSK-08:** Add rendering tests for compact and expanded lists, default-shell width limits, Unicode preservation, and omission of parameters and descriptions.
- **TSK-09:** Prompt-content tests assert only contract text explicitly required by the PRD.
- **TSK-10:** Implement tests and production changes using RED–GREEN–REFACTOR.

### Validation

- **CHK-01:** Run targeted Bun tests after each behavior slice.
- **CHK-02:** Run `bun run test`, `bun run typecheck`, `bun run check`, and `bun run verify`.
- **CHK-03:** Validate single-extension loading for `mcp-wrapper` and `system-prompt` with `pi --no-session -p -e`.
- **CHK-04:** Validate whole-package loading with `pi --no-session -p -e .`.
- **CHK-05:** Run a live pi check with temporary configuration, an isolated fake MCP server, and a temporary diagnostic extension. Inspect the emitted system prompt and `pi.getActiveTools()` before and after activation.
- **CHK-06:** Verify the live check independently in a main-agent session and a child-agent session, then remove temporary state.

### Documentation and implementation surface

- **DLV-01:** Add `pi-package/shared/toolsets/contracts.ts`.
- **DLV-02:** Add `pi-package/shared/toolsets/runtime.ts` and its adjacent tests.
- **DLV-03:** Add `pi-package/shared/toolsets/rendering.ts` and its adjacent tests.
- **DLV-04:** Update `pi-package/shared/agent-runtime-composition.ts` and its tests.
- **DLV-05:** Update `main-agent-selection`, `run-subagent`, and `enable-tools` to use per-session composition.
- **DLV-06:** Update `mcp-wrapper` configuration, metadata hashing, lifecycle, catalog registration, and behavior tests.
- **DLV-07:** Update `system-prompt` macro handling, bundled template, documentation, and tests.
- **DLV-08:** Update `docs/extensions/mcp-wrapper.md`.
- **DLV-09:** Save this document as `docs/specs/features/on-demand-toolsets/on-demand-toolsets_solution.md`.

## Overengineering and Overspecification Considerations

- **TRD-01:** A shared runtime is required because the provider, system-prompt macro, activation tool, session history, and agent composition cross extension boundaries.
- **TRD-02:** No standalone toolsets extension is introduced; this avoids another package lifecycle owner.
- **TRD-03:** Startup discovery remains unchanged. Lazy MCP startup, deactivation, multi-server toolsets, toolset splitting, and non-MCP providers are not implemented.
- **TRD-04:** The generic provider boundary permits later providers without implementing their behavior now.
- **TRD-05:** Extending `AgentRuntimeComposition` avoids a second active-tool arbiter and preserves one per-session owner.

## Open Questions

None.

## References

- **REF-01:** `docs/specs/features/on-demand-toolsets/on-demand-toolsets_problem.md` — approved problem statement and glossary.
- **REF-02:** `docs/specs/features/on-demand-toolsets/on-demand-toolsets_prd.md` — approved requirements.
- **REF-03:** `docs/extensions/system-prompt.md` — system-prompt macro contract.
- **REF-04:** `docs/extensions/mcp-wrapper.md` — MCP wrapper behavior and configuration.
- **REF-05:** `pi-package/shared/agent-runtime-composition.ts` — per-`ExtensionAPI` composition and filtering.
- **REF-06:** `pi-package/extensions/run-subagent/agent-policy.ts` — child policy and nested-depth behavior.
- **REF-07:** Pi `docs/extensions.md`, “State Management” — branch-aware state reconstruction through `toolResult.details`.
