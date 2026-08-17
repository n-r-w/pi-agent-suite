# Idea: On-Demand Toolsets

## Definitions

- **tool**: An individual operation that an LLM can invoke.
- **toolset**: A named collection of tools that becomes available as one unit.
- **tool provider**: A source that supplies one or more tools.
- **MCP server**: The tool-provider type supported by this feature.
- **model provider**: The service receiving the LLM request, including active tool definitions.
- **activation trigger**: Compact metadata describing when the LLM should activate a deferred toolset.
- **deferred toolset**: A toolset excluded from model-provider tool definitions and represented by an activation trigger.
- **active toolset**: A toolset whose tools are available to the LLM.

## Context and Problem

`mcp-wrapper` exposes every discovered MCP tool to the model provider. Users who configure multiple specialized MCP servers receive irrelevant tool definitions in the model context even when a task requires only one toolset.

## Goal

Keep specialized toolsets outside the model context until needed while allowing the LLM to discover and activate them during a pi session.

## Scenarios

- A new session starts with eager MCP toolsets available and deferred toolsets represented only by activation triggers.
- The LLM identifies a relevant trigger and activates its toolset.
- A resumed session restores activations represented in its active history branch.
- Rewinding or branching before an activation returns that toolset to deferred state.
- Invalid activation requests leave toolset state unchanged.
- Invalid configuration produces a startup warning and disables the extension without preventing pi from starting.

## Scope and Non-Scope

### Scope

- Marking individual MCP servers as deferred toolsets.
- Exposing compact activation triggers through the system prompt.
- Activating all tools belonging to one deferred toolset.
- Persisting activation state within pi session history.

### Non-Scope

- Supporting tool providers other than MCP servers.
- Grouping several MCP servers into one toolset.
- Splitting one MCP server into several toolsets.
- Optimizing MCP connection, discovery, or server resource usage as an independent goal.
- Preserving historical tool availability after the user removes or renames its toolset in configuration.

## Requirements

### Configuration

- Each MCP server can be configured either for immediate availability or as one deferred toolset.
- A deferred toolset configuration requires `name` and `description`.
- Configured `name` values must be unique.
- `name` must contain at least one non-whitespace character and must not contain leading or trailing whitespace.
- `description` must contain at least one non-whitespace character and must not contain leading or trailing whitespace.
- A duplicate name or any other configuration error must produce a startup warning and disable `mcp-wrapper`.
- Configuration errors must not prevent pi from starting.
- MCP servers without deferred-toolset configuration must retain `mcp-wrapper` behavior defined for non-deferred servers.

### Initial availability

- Tools belonging to a deferred toolset must not be included in model-provider tool definitions before activation.
- MCP instructions and other provider-derived prompt content belonging to a deferred toolset must not appear before activation.
- Before activation, the system prompt can represent the toolset only through its configured activation trigger.
- The system-prompt template must expose activation triggers through the `{{toolsets}}` variable.
- Activation triggers must not be appended to the system prompt when its template does not contain `{{toolsets}}`.
- Each deferred toolset must be represented as:
  ```xml
  <toolsets>
  <toolset name="configured name" description="configured activation rules"/>
  </toolsets>
  ```
- Multiple deferred toolsets must appear as multiple `<toolset>` elements inside one `<toolsets>` element.
- `{{toolsets}}` must expand to an empty string when no deferred toolsets remain.

### Unavailable MCP metadata

- A deferred MCP server must participate in the toolset catalog only after its tool metadata has been loaded successfully.
- A deferred MCP server without loaded tool metadata must not produce a `<toolset>` trigger.
- `activate_toolset` must not accept the name of a deferred MCP server without loaded tool metadata.
- Existing MCP startup diagnostics must warn the user about the metadata loading failure.
- The toolset may become available after a successful `/mcp-refresh` or in a later session.

### Activation tool

- The LLM must have access to a tool named `activate_toolset` while at least one deferred toolset remains in the active history branch.
- `activate_toolset` must become unavailable after no deferred toolsets remain.
- The tool must have a required string parameter named `name`.
- The tool parameter schema must enforce a minimum string length of one character independently of configuration validation.
- `activate_toolset.name` must use exact, case-sensitive matching against the configured toolset name.
- The tool description visible to the LLM must explain that it activates a needed toolset listed in `<toolsets>` so that the toolset’s tools become available.
- Configuration-only whitespace restrictions must not be duplicated in the tool parameter schema.
- A non-empty parameter that does not identify a deferred or active configured toolset must be handled as an unknown name.

### Successful activation

- A successful `activate_toolset` call must make every tool of the selected MCP server available to the LLM.
- After activation, the MCP server must follow the same tool availability, MCP instruction visibility, call routing, result mapping, and presentation behavior as a non-deferred server.
- The activated toolset must be removed from subsequent `<toolsets>` expansions.
- Repeated activation of an active toolset must return success without changing its state.

### Activation output

- A successful `activate_toolset` result sent to the LLM must contain the complete list of tool names made available to the current agent.
- The LLM result must not contain tool parameters or individual tool descriptions.
- A repeated activation of an active toolset must identify it as already active and contain its complete currently available tool-name list.
- Collapsed TUI rendering must show activation status, tool count, and a shortened tool-name list.
- Expanded TUI rendering must show the complete tool-name list.
- TUI rendering must not show tool parameters or individual tool descriptions.
- Main-agent and subagent screens must use the same collapsed and expanded rendering behavior.

### Activation failure

- An unknown name or MCP activation failure must return an error from `activate_toolset`.
- A failed activation must not make any tools from the selected toolset available.
- A failed activation must leave the selected toolset deferred.
- The trigger must remain in subsequent `<toolsets>` expansions.
- A failed activation may be retried.

### Session state

- Activation state must belong to one pi session rather than all sessions using the same configuration.
- Resuming the same session after restarting pi must restore activation state from the active history branch.
- A new session must start with all configured deferred toolsets in deferred state.
- A history branch containing a successful activation must treat that toolset as active.
- Rewinding or branching to history before a successful activation must treat that toolset as deferred.
- Removing or renaming an activated toolset in configuration must produce a warning when the session is resumed.
- After such a configuration change, `mcp-wrapper` must continue using the valid current configuration.
- Historical availability is not guaranteed for tools removed or renamed through configuration changes.

### Agent tool restrictions

- Activating a toolset must remove only its deferred restriction.
- Activation must not grant a tool excluded by the current agent’s tool restrictions.
- A tool from a deferred toolset must become available only when:
  1. the toolset is active in the current pi session branch; and
  2. the current agent’s tool restrictions allow the tool.
- `<toolsets>` must include only deferred toolsets containing at least one tool allowed for the current agent.
- Activating such a toolset must expose only its tools allowed for the current agent.
- `activate_toolset` must be available only when:
  1. the current agent’s tool restrictions allow `activate_toolset`; and
  2. at least one deferred toolset contains a tool allowed for that agent.
- Main agent and each subagent must maintain activation state independently in their separate pi sessions.
- Activation in a main-agent session must not activate the same toolset in a subagent session, and vice versa.

## Open Questions

None.

## Technical Supplement

None.

## References

- [Problem Statement](./on-demand-toolsets_problem.md)
- [`system-prompt` extension](../../../extensions/system-prompt.md)
- [`mcp-wrapper` extension](../../../extensions/mcp-wrapper.md)
- `pi-package/extensions/vision/index.ts`: independent tool parameter schema validation example.
