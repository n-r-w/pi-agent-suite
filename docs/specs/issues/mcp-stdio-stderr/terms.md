# Terms

- Active stderr log: the `mcp-wrapper/stdio.log` file that receives current stdio MCP server diagnostics.
- Archived stderr log: the `mcp-wrapper/stdio.log.1` file replaced during the next rotation.
- Configured server key: the key of one entry in `mcpServers`, used by the wrapper to identify its route.
- MCP server name: the name reported by the MCP server during protocol initialization.
- Server diagnostic: text that a stdio MCP server writes to its stderr stream.
- Stdio MCP server: an MCP server that exchanges protocol messages through standard input and standard output.
