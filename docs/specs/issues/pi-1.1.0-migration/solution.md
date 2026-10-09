# Technical solution: Pi 1.1.0 migration

## Problem statement

See [problem.md](problem.md), [requirements](prd.md), and [terms](terms.md).

## Proposed solution

### Dependency alignment

- Pin the four host-provided Pi packages to 1.1.0 in the development dependencies and package peer dependencies. Regenerate the root and package lockfiles through `make pi-update PI_VERSION=1.1.0`, because that target already updates both dependency declarations and validates the package.
- The isolated update completed successfully and resolved all four packages to 1.1.0 from both package roots. The maintainer retains the project's host-version contract through exact pins; version ranges would permit unassessed host versions.
- This approach serves FRQ-01 and FRQ-03. The dependency boundary is `package.json`, `pi-package/package.json`, `bun.lock`, `pi-package/bun.lock`, and `pi-package/package-lock.json`.

### Render-context fixtures

- Complete the two test fixtures with the tool-render context metadata required by Pi 1.1.0. Pi supplies that metadata during normal execution, so the correction belongs in the fixtures.
- The target TypeScript compiler reported two incompatible fixtures in `pi-package/extensions/mcp-wrapper/index.test.ts` and `test/support/tool-render-context.ts`. After those contexts were completed in the isolated copy, the validation tools reported success with 1676 passing tests and one skip.
- This approach serves FRQ-01 and NRQ-01. Use the target public contract directly; introducing a production compatibility layer would add another contract without correcting a production failure.

### Native tool presentation in the subagent screen

- Continue using Pi's public `ToolExecutionComponent` and the shared tool-presentation registry. Preserve the recorded execution duration when the management pane adapts a tool result for that component.
- Obtain Pi's effective tool-output padding through its public settings API, following the repository's `SettingsManager` pattern. Sample the padding when an overlay opens and pass the value to its tool components, alongside the already sampled expansion state.
- The saved-session and active-entry loaders remain the sources of conversation data. Results without a recorded duration retain Pi's presentation for absent timing information.
- In the paired rendering check, the target main component displayed `Took 2.5s` and zero columns of horizontal padding for a saved duration of 2500 milliseconds and a zero-padding setting. The target management pane omitted the duration and used one column of padding. Its result adapter discards timing metadata and its component constructor receives default options, which explains both differences.
- This approach serves FRQ-01 and FRQ-03. The management pane delegates compact and expanded presentation to Pi's native component. A separate duration formatter or tool frame would duplicate Pi behavior and increase maintenance across the two screens.

### Council participant tool restrictions

- Retain the council's resolved tool allowlist, including mandatory `read`. Derive selective native MCP exclusions from that allowlist and apply them through Pi's CLI when launching each participant.
- Preserve explicitly allowed native MCP server tools and resource helpers. Keep the project's MCP wrapper tools under the tool policy that already resolves their names.
- Pi 1.1.0 retains native MCP tools outside some CLI allowlists, making them callable through `codemode`. A paired real-CLI check showed that `read,codemode` denied a native echo call on 1.0.2 and permitted it on 1.1.0. Selective exclusions restored denial on the target.
- The same check permitted an explicitly allowed native echo tool while denying a second native tool. A resource-only policy permitted `list_mcp_resources` while denying `read_mcp_resource`. These results justify selective filtering at participant startup.
- This approach serves FRQ-01 and FRQ-03. Blanket `--no-mcp` would also disable authorized native capabilities. Changing only visible active tools would leave the indirect callable namespace outside the intended restriction.
- The exclusion rules depend on the target Pi CLI's native MCP naming and filtering contract. The exact host-version pin and child-process integration checks bound that dependency.

### Image data and image type

- Keep encoded image data and its image type together through the vision loader's compression boundary. Forward the image type supplied by Pi's resize result with the resized data; preserve the original pair when Pi leaves the image unchanged.
- A generated 100 by 100 pixel PNG produced a 3545-byte JPEG on both Pi versions. The vision loader returned that JPEG with the original PNG type because its compression helper returns only the data. The model-request builder then copies the loader's image type into the request.
- For that conversion, the loader must return JPEG data identified as `image/jpeg`. A PNG that remains PNG retains `image/png`.
- This approach serves FRQ-04 and the approved pre-existing-defect exception in FRQ-03. Pi continues to own encoding, resizing, and quality control. Re-encoding the output to preserve the input format would add work and could defeat the configured compression limit.

### Whole-project compatibility assessment

- Retain the extension registration, lifecycle controllers, model-alias resolution, and auxiliary-model paths for which the investigation identified no target incompatibility. The [compatibility assessment](compatibility.md) lists the examined capabilities, evidence, and remaining uncertainty across all 26 registered entry points and shared functionality.
- Reassess that entire inventory after the adaptations. Use `bun run verify` for package validation and isolated real-Pi checks where unit tests cannot establish loading, single registration, or child-process behavior.
- Exercise the corrected rendering, council restrictions, and image-type behavior with regression checks. Preserve the enabled, disabled, invalid-configuration, cancellation, continuation, and compact-versus-expanded scenarios that each component already serves.
- Use isolated fixtures and fake providers, authentication, transports, playback, and clipboard effects. Test callback outcomes, tool access, data integrity, lifecycle decisions, and rendered output. Prompt wording remains outside test assertions.
- This approach serves FRQ-01, FRQ-02, FRQ-03, and NRQ-01. Existing passing tests support the assessed paths; the runtime discrepancies demonstrate why test totals alone cannot establish complete compatibility.

## Overengineering and overspecification considerations

- The host version, tool-presentation component, resolved tool policy, and image loader remain the owners of their respective contracts. The migration adds no parallel lifecycle controller, renderer, model selector, or image encoder.
- Configuration-derived rendering values remain local to each open overlay. Participant restrictions are resolved per launch, and processed-image data remains local to each load. Reopening an overlay or retrying a participant launch recomputes those values from its inputs without accumulating another global state.
- The existing native overflow retry failure remains an explicit assessment limitation. It reproduced on both versions, and its correction is outside the approved scope. The migration adds no passive-context workaround and retains the skipped test until the upstream scenario succeeds.
- Real provider responses, authentication refresh, audio output, desktop clipboard operation, cmux execution, and remote SSH delivery remain outside live validation. Their extension-side behavior is assessed through isolated fakes and API review, as required by NRQ-01.

## Open questions

None affecting the approved technical approaches. The [implementation report](implementation.md) records the delivered changes, successful target validation, and remaining compatibility limits.

## References

- [Requirements](prd.md)
- [Terms](terms.md)
- [Compatibility assessment](compatibility.md)
- `Makefile`: `pi-update` target.
- `pi-package/extensions/run-subagent/management-screen/conversation.ts`: conversation composition and tool-result adaptation.
- `pi-package/extensions/run-subagent/management-screen/screen.ts`: per-open screen factory.
- `pi-package/shared/native-compaction-settings.ts`: public Pi settings access pattern.
- `pi-package/extensions/convene-council/startup.ts`: participant CLI tool arguments.
- `pi-package/extensions/vision/image.ts`: image loading and compression.
- `pi-package/extensions/vision/delegate.ts`: image data and image type in model requests.
- `test/integration/compaction-overflow-retry.test.ts`: passing scenarios and the skipped passive restoration scenario.
- `docs/pi-issues/session-compact-message-misses-overflow-retry/`: isolated upstream reproducer.
- [Pi 1.1.0 release notes](https://pi.dev/changelog/releases/1.1.0)
