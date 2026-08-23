# MCP Wrapper Extension

## Purpose

The MCP wrapper extension registers configured MCP server tools as Pi tools. Pi sends each active generated tool's description and parameter schema through the provider tool payload.

## Configuration file

By default, place the configuration at `agent-suite/mcp-wrapper/config.json`. If the file is missing, no MCP tools are registered.

## Full configuration example

```json
{
  "settings": {
    "enabled": true,
    "timeouts": {
      "startupSeconds": 30,
      "listToolsSeconds": 15,
      "callSeconds": 120,
      "maxTotalSeconds": 180
    },
    "widgetLineBudget": 5
  },
  "mcpServers": {
    "files": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "env": {
        "EXAMPLE_TOKEN": "value"
      },
      "cwd": "/tmp",
      "onDemand": {
        "name": "workspace-files",
        "description": "Activate for workspace file operations."
      },
      "additionalInstructions": "Use file tools for workspace operations.\nKeep changes scoped to the requested files."
    },
    "docs": {
      "type": "streamableHttp",
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer token"
      }
    }
  }
}
```

## Parameters

Top-level parameters:

| Parameter | Required | Type or shape | Default | Meaning |
| --- | --- | --- | --- | --- |
| `settings` | No | Object | Uses defaults for all settings | Extension settings. |
| `mcpServers` | Yes when the config file exists | Object keyed by non-empty server name | None | MCP servers to expose as Pi tools. Empty object registers no MCP tools. |

`settings` parameters:

| Parameter | Required | Type or shape | Default | Meaning |
| --- | --- | --- | --- | --- |
| `enabled` | No | Boolean | `true` | Enables or disables MCP tool registration. `false` registers no MCP tools. |
| `timeouts` | No | Object | Uses defaults for all timeout fields | Time limits for MCP startup, discovery, and calls. Values are seconds. |
| `widgetLineBudget` | No | Positive integer | `5` | Number of result preview lines shown before the collapsed-output hint. |

## Tool display

Collapsed call arguments and text results are normalized into one logical line before Pi applies visual wrapping and `widgetLineBudget`:

- Repeated ASCII spaces and line-control whitespace become one ASCII space.
- C0, C1, and terminal control sequences are removed.
- Complete JSON text is normalized inside decoded string tokens. Non-string JSON lexemes, literal backslashes, paths, regular expressions, and visible Unicode remain unchanged.

Expanded calls retain their complete serialized arguments. Expanded results retain the original MCP text and use Pi Markdown rendering.

`settings.timeouts` parameters:

| Parameter | Required | Type or shape | Default | Meaning |
| --- | --- | --- | --- | --- |
| `startupSeconds` | No | Positive integer | `30` | Maximum wait for starting a connection to an MCP server. |
| `listToolsSeconds` | No | Positive integer | `15` | Maximum wait for listing tools from an MCP server. |
| `callSeconds` | No | Positive integer | `120` | Maximum wait for one MCP tool call. |
| `maxTotalSeconds` | No | Positive integer | `180` | Maximum total time budget for an MCP operation. |

Each `mcpServers` entry must be either a `stdio` server or a `streamableHttp` server. `type` may be omitted for `stdio` servers.

`stdio` server parameters:

| Parameter | Required | Type or shape | Default | Meaning |
| --- | --- | --- | --- | --- |
| `type` | No | `"stdio"` | `"stdio"` when omitted | Starts a local MCP server process over standard input and output. |
| `command` | Yes | Non-empty string | None | Command used to start the MCP server. |
| `args` | No | Array of strings | `[]` | Arguments passed to `command` unchanged. |
| `env` | No | Object with string values | `{}` | Environment variables for the server process. Values are literal strings. Configured values override inherited environment variables with the same name. |
| `cwd` | No | String | Not set by the extension | Working directory for the server process. |
| `onDemand` | No | Object with `name` and `description` | Not set | Defers this server as one named toolset. See [On-demand toolsets](#on-demand-toolsets). |
| `additionalInstructions` | No | String | Not set | Local instructions persisted for the model when an eager server starts active or its deferred toolset is activated. JSON `\n` escapes represent newlines. |

`streamableHttp` server parameters:

| Parameter | Required | Type or shape | Default | Meaning |
| --- | --- | --- | --- | --- |
| `type` | Yes | `"streamableHttp"` | None | Connects to an MCP server over streamable HTTP. |
| `url` | Yes | Non-empty string | None | MCP server URL. |
| `headers` | No | Object with string values | `{}` | HTTP headers sent to the MCP server. Values are literal strings. |
| `onDemand` | No | Object with `name` and `description` | Not set | Defers this server as one named toolset. See [On-demand toolsets](#on-demand-toolsets). |
| `additionalInstructions` | No | String | Not set | Local instructions persisted for the model when an eager server starts active or its deferred toolset is activated. JSON `\n` escapes represent newlines. |

## Config rules

- Only the parameters listed above are supported.
- Placeholders such as `${VAR}` and `$env:VAR` are not expanded.
- Commands, arguments, environment values, headers, and URLs are used as written.
- `additionalInstructions` is omitted when absent, empty, or whitespace-only. Nonblank text is preserved as written, including surrounding whitespace and newlines.
- When both server-provided MCP instructions and `additionalInstructions` exist, server-provided text comes first, followed by one blank line and local text.
- At session initialization, server instructions are persisted in one hidden `mcp-instructions` replacement only for servers with at least one generated Pi tool in the runtime's final active tool set. Registration alone is not sufficient.
- A deferred server's instructions are included in the first successful `activate_toolset` result. An idempotent activation does not repeat them.
- Session restoration derives the effective instruction set from the latest hidden replacement and later successful `activate_toolset` results. It publishes a replacement when the exact rendered server-block set differs from the active generated MCP servers.
- When no generated MCP server remains active, `<mcp_instructions />` replaces stale instruction blocks in the provider-visible segment. No empty record is added when the segment already contains no MCP instructions.
- MCP instructions do not modify the system prompt.
- Changing only `additionalInstructions` does not invalidate cached MCP metadata or trigger discovery; the text is read from configuration on the next startup.
- Changing only `onDemand.name` or `onDemand.description` does not invalidate cached MCP metadata.

## On-demand toolsets

Add `onDemand` to a `stdio` or `streamableHttp` server to defer that server's tools until the model activates its toolset:

```json
"onDemand": {
  "name": "workspace-files",
  "description": "Activate for workspace file operations."
}
```

`onDemand` accepts exactly `name` and `description`. Each is a trimmed, non-empty string. Names are unique across `mcpServers` with exact, case-sensitive matching. Invalid declarations disable `mcp-wrapper` for the session and show its startup warning; pi continues to start.

A server without `onDemand` is eager: its loaded tools are available under the normal MCP behavior. A deferred server's generated definitions are registered once its metadata loads, but its tools and MCP instructions remain unavailable until activation. A deferred server with unavailable metadata has no trigger or activation route; normal MCP startup diagnostics report the metadata failure.

`activate_toolset` is available only if it is allowed for the current agent and a loaded, still-deferred toolset has at least one tool allowed for that agent. Activation is exact and case-sensitive. It exposes only that agent's allowed tools, is idempotent for an active toolset, and leaves the toolset deferred when activation fails. It disappears after the final eligible toolset is activated. Activation state is local to the pi session and active history branch; main and subagent sessions do not share it. A resumed branch restores its last valid activation snapshot; stale names from changed configuration are warned about and ignored.

The activation result gives the model the status and complete list of currently available tool names, without tool parameters or descriptions. On the first successful activation, the same persisted tool result also contains the activated servers' MCP instructions. Main-agent and subagent screens render the status followed by comma-separated tool names. Collapsed rendering shows at most two wrapped content lines, adds an ellipsis when content is hidden, and reports the exact number of hidden lines; expanded rendering shows the complete wrapped list without truncation.

Activation uses already loaded MCP metadata. It does not create a separate MCP connection; normal MCP tool execution retains connection readiness and routing behavior.

## Manual cache refresh

Use `/mcp-refresh` to rebuild cached MCP tool metadata from the configured servers.

The command ignores the existing cache, discovers tools from every configured server, writes a new `cache.json`, and reloads the pi runtime. The replacement catalog applies additions and suppresses removed or obsolete MCP tool names. A newly loaded deferred server can then acquire a trigger; a removed or unavailable deferred server has none.

## Active-tool composition

`AgentRuntimeComposition` is the single owner of final active-tool reconciliation. It starts with a stable baseline order and applies main-agent, child/depth, workflow, vision, and deferred-toolset restrictions as remove-only layers. A tool restored after a restriction is lifted returns to its baseline position; no layer can add or reorder an upstream-excluded tool.

## Tool names

Generated Pi tool names are based on the server name and MCP tool name:

```text
server_slug_tool_slug
```

Slugs are lowercase. Characters outside `a-z` and `0-9` become `_`. The generated name must start with a lowercase ASCII letter or `_`. Names longer than 64 characters are shortened. Routes with invalid or colliding generated names are not registered.
