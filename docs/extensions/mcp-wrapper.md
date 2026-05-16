# MCP Wrapper Extension

The MCP wrapper extension reads `agent-suite/mcp-wrapper/config.json`, connects to configured MCP servers, discovers supported MCP tools, and registers one Pi tool per supported MCP tool.

## Config

```json
{
  "settings": {
    "enabled": true,
    "timeouts": {
      "startupSeconds": 30,
      "listToolsSeconds": 15,
      "callSeconds": 120,
      "maxTotalSeconds": 180
    }
  },
  "mcpServers": {
    "files": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "env": {
        "EXAMPLE_TOKEN": "value"
      }
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

Rules:
- Missing config file means no MCP tools are registered.
- `settings.enabled` defaults to `true`.
- Missing timeout fields use the defaults shown above.
- `mcpServers` must be an object when the config file exists.
- Empty `mcpServers` means no MCP tools are registered.
- Supported server types are `stdio` and `streamableHttp`.
- A server with `command` and no `type` is treated as `stdio`.
- Configured `env` and `headers` values are literal strings. Placeholders such as `${VAR}` and `$env:VAR` are not interpolated.
- Stdio child process env is `process.env` filtered to string values plus configured `stdio.env`. Configured values override inherited values.
- Commands and args are passed unchanged. `npx` and `npm` are not rewritten.
- Host MCP config files are not read or merged.

## Tool names

Generated Pi tool names use:

```text
${serverSlug}_${toolSlug}
```

The final name must match `^[A-Za-z_][A-Za-z0-9_]{0,63}$`.

Invalid handling:
- Invalid `serverKey` rejects only that server.
- Invalid MCP tool name rejects only that tool.
- Duplicate generated names reject all colliding routes.

## Schema support

MCP `inputSchema` is passed to Pi tool registration as JSON Schema. The wrapper does not maintain its own JSON Schema keyword allowlist. Missing `inputSchema` uses an empty object schema.

## Prompt visibility

Each registered MCP tool sets Pi `promptSnippet` so the tool appears in the `Available tools` section of the system prompt. The snippet uses `Tool from MCP server "${serverKey}": ${description}`, truncated to 100 characters at a word boundary. Tools without a description use `Tool from MCP server "${serverKey}".`.

The provider tool `description` uses the same server prefix without truncation.

MCP initialize `instructions` are appended to the system prompt for connected servers with at least one registered Pi tool. Instructions are not truncated.

```xml
<mcp_instructions>
  <server name="fetch">
Use fetch for web pages.
  </server>
</mcp_instructions>
```

Escaping rules:
- `server name` escapes `&`, `"`, and `<`.
- Instruction text escapes only `<`.

The block is added through `before_agent_start` after `system-prompt` replaces the base prompt. `pi.sendMessage` is not used.

Startup notifications list connected servers, registered tools, failed servers, and rejected tools.

## Output handling

- Text output uses Pi-style truncation.
- Truncated full output is saved to a temp file and the model-facing result includes the path.
- Under-limit images are returned as Pi image content.
- Oversized image payloads are saved to temp files with mode `0o600`, and the model-facing result includes the file path.

## Runtime behavior

- Config is read during extension startup or Pi reload.
- Editing the config file during an active session does not change registered MCP tools or active MCP connections until restart or reload.
- Failed MCP servers do not block healthy servers.
- Failed servers and rejected routes are shown through MCP status entries in the footer.
