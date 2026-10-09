# Pi 1.1.0 migration implementation

## Delivered changes

The project now pins Pi 1.1.0 in both package manifests and their lockfiles. The project-local CLI reports `1.1.0`, and all four host-provided Pi packages resolve to `1.1.0` from both package roots. The globally installed CLI remains unchanged.

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| FRQ-01, FRQ-03 | `make pi-update PI_VERSION=1.1.0` updated the dependency declarations and lockfiles. | Version inspection from both package roots and `./node_modules/.bin/pi --version`. |
| FRQ-01, NRQ-01 | The two tool-render fixtures supply `durationMs` and `outputPad`. | `pi-package/extensions/mcp-wrapper/index.test.ts`, `test/support/tool-render-context.ts`, and passing strict TypeScript checks. |
| FRQ-01, FRQ-03 | The management pane forwards the tool-result message to Pi's native component, including its recorded duration. The overlay factory samples effective `outputPad` on each open. | `conversation.test.ts` checks padding 0 and 1, duration 2500 milliseconds, absent duration, and compact and expanded views. `screen.test.ts` checks resampling on reopen. Both files are under `pi-package/extensions/run-subagent/management-screen/`. |
| FRQ-01, FRQ-03 | Council startup adds native MCP exclusions to the resolved tool allowlist. A selected server tool activates Pi's server-tool allowlist filtering. With no selected server tool, startup excludes `mcp__*`. Startup also excludes each unlisted resource helper. | `pi-package/extensions/convene-council/startup.test.ts` and `test/integration/council-native-mcp.test.ts`. |
| FRQ-04 | The vision compression helper returns encoded bytes and their MIME type together. The loader retains the original pair when compression is disabled or the resizer returns no result. | `pi-package/extensions/vision/image.test.ts` checks JPEG, GIF, unchanged PNG, absent resize output, and disabled compression. A generated PNG also passed through the real Pi resizer and returned JPEG bytes with `image/jpeg`. |
| FRQ-02 | The compatibility inventory retains its capability-level evidence and external-effect limits. | [Updated compatibility assessment](compatibility.md). |
| NRQ-01 | Added tests use temporary directories, an in-memory settings fake, a deterministic provider, and a local stdio MCP server. They assert tool access, output, and image data rather than prompt content. | The native MCP integration uses `test/support/temp-dir.ts` and the fixtures `native-mcp-provider.ts` and `native-mcp-stdio.ts` under `test/fixtures/`. |

## Regression evidence

Before the fixes, the regression tests reproduced these failures:

- The vision loader returned `image/png` for resized JPEG and GIF data.
- The management pane used one column of padding when configured for zero and omitted `Took 2.5s` for a recorded 2500-millisecond duration.
- Council participants with `codemode` could reach unlisted native MCP tools. The real-Pi integration also reproduced the resource-only policy failure.

After the fixes, each regression test passed. The real-Pi integration checks these participant policies with the complete package loaded:

| Additional tools | Echo tool | Second server tool | List resources | Read resource |
| --- | --- | --- | --- | --- |
| `codemode` | Denied | Denied | Denied | Denied |
| `codemode`, `mcp__fixture__echo` | Allowed | Denied | Denied | Denied |
| `codemode`, `list_mcp_resources` | Denied | Denied | Allowed | Denied |

Each participant also retains mandatory `read`. The test explicitly loads `builtin:codemode` and `builtin:mcp` because Pi's `--no-extensions` disables built-in extensions too.

A separate isolated CLI run loaded the complete package and a temporary debug extension. Inspection of its `before_agent_start` dump showed the runtime system prompt and active `read` and `codemode` tools. The allowed native echo tool completed through `codemode`. The MCP server used `codemode` exposure, so the echo tool was callable without a direct tool declaration. Temporary state was removed after the run.

The real image check used a generated 100 by 100 pixel PNG, JPEG quality 85, and a 4000-byte compression limit. The loader returned 2896 bytes identified as `image/jpeg`; the bytes began with the JPEG signature `ffd8ff`.

## Validation results

After the final code and configuration changes, `bun run verify` completed successfully:

- `bun run test`: 1690 passed, one skipped, zero failed; 6458 assertions across 194 Bun test files. Go tests also passed.
- `bun run typecheck`: passed.
- `bun run check`: passed, including Biome, Go formatting, and Go vet.

Bun's package-script environment resolves `pi` to the project-local 1.1.0 binary. The native MCP integration also invokes that binary by its absolute project path. The suite includes standalone and whole-package loading, single-registration checks, child RPC behavior, model aliases, extension configuration, and cross-extension scenarios listed in the compatibility inventory.

The initial `make pi-update PI_VERSION=1.1.0` run stopped at the two expected render-context type errors after updating dependencies. The successful final `bun run verify` includes their corrections.

## Approved exception and dependency resolution

The user approved O1-1, a `noDefaultExport` exception in `biome.jsonc` only for `test/fixtures/native-mcp-provider.ts`. Pi requires a default-exported extension factory. The provider remains a typed TypeScript fixture. The exception is needed while this file is loaded as a Pi extension; remove it if the fixture no longer serves as an extension entry point.

The prescribed package lockfile regeneration also resolved the transitive `@babel/runtime` dependency from 7.29.7 to 7.29.10 in `pi-package/bun.lock`, within `json-schema-to-ts`'s `^7.18.3` range. Direct dependency declarations changed only for the four Pi packages.

## Remaining limits

The pre-existing passive context restoration failure during native overflow retry remains represented by the skipped test. Its correction is outside this migration's scope.

Live LLM providers, real authentication, audio output, desktop clipboard, cmux, SSH delivery, and private configuration remain unverified, as required by the isolated-check boundary. The compatibility conclusion applies to the exercised behavior.
