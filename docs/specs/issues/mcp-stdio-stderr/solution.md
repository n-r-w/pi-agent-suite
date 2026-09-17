# Technical Solution: Preserve stdio MCP server diagnostics

## Problem Statement

See [problem.md](problem.md).

## Proposed Solution

### Transport construction

- Pass `stderr: "pipe"` to each `StdioClientTransport`.
- Attach the stderr listener before `Client.connect()` starts the transport so startup diagnostics are captured.
- Keep command, arguments, environment, and working-directory handling unchanged.

### Log writing

- Use the shared `mcp-wrapper/stdio.log` path under the agent-suite directory.
- Prefix each stderr chunk with an ISO timestamp, configured server key, and current MCP server name as `[configured-key] [server-name]`.
- Use `initializing` until `Client.connect()` completes, then use `Client.getServerVersion()?.name` or `unnamed` when the connected server reports no name.
- Append through `fs.promises.appendFile()`, which opens and closes the path for each operation.
- Retry one failed append once. Discard the chunk after the second failure without changing MCP server behavior.
- Queue chunks from one client to preserve their local arrival order.

### Rotation

- Check the active file size before each append.
- When the size exceeds 5 MiB, remove `stdio.log.1` and rename the active file to `stdio.log.1`.
- Ignore rotation races and continue with the append. Concurrent local processes may lose or archive records near the rotation boundary.

### Verification

- Test a failed first append followed by a successful retry.
- Test replacement of an existing archive after the active file exceeds 5 MiB.
- Start an isolated wrapper process with a real SDK stdio transport and verify that an early server diagnostic reaches the shared log.
- Run package tests, type checks, lint checks, and formatting checks through `bun run verify`.

## Overengineering and Overspecification Considerations

The solution uses Node.js file APIs and two fixed log paths. It does not add a logging dependency, inter-process locking, per-process files, configurable policies, or terminal rendering.

## Open Questions

None.

## References

- `pi-package/extensions/mcp-wrapper/sdk-client-factory.ts` - stdio transport construction.
- `pi-package/extensions/mcp-wrapper/stdio-log.ts` - append, retry, and rotation behavior.
- `pi-package/extensions/mcp-wrapper/sdk-client-protocol.test.ts` - real SDK transport behavior tests.
