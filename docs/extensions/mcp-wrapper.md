# MCP Wrapper Extension

## Purpose

The MCP wrapper extension registers configured MCP server tools as Pi tools.

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
      "cwd": "/tmp"
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

`streamableHttp` server parameters:

| Parameter | Required | Type or shape | Default | Meaning |
| --- | --- | --- | --- | --- |
| `type` | Yes | `"streamableHttp"` | None | Connects to an MCP server over streamable HTTP. |
| `url` | Yes | Non-empty string | None | MCP server URL. |
| `headers` | No | Object with string values | `{}` | HTTP headers sent to the MCP server. Values are literal strings. |

## Config rules

- Only the parameters listed above are supported.
- Placeholders such as `${VAR}` and `$env:VAR` are not expanded.
- Commands, arguments, environment values, headers, and URLs are used as written.

## Manual cache refresh

Use `/mcp-refresh` to rebuild cached MCP tool metadata from the configured servers.

The command ignores the existing cache, discovers tools from every configured server, writes a new `cache.json`, and reloads the pi runtime. The reload applies added tools and removes tools that no longer exist.

## Tool names

Generated Pi tool names are based on the server name and MCP tool name:

```text
server_slug_tool_slug
```

Slugs are lowercase. Characters outside `a-z` and `0-9` become `_`. The generated name must start with a lowercase ASCII letter or `_`. Names longer than 64 characters are shortened. Routes with invalid or colliding generated names are not registered.
