# Technical Solution: Footer Cache Hit Rate

## Problem Statement
- PRB-01: The custom footer replaces Pi's native footer but does not display the latest prompt cache hit rate available in assistant usage data.

## Proposed Solution

### SOL-01: Cache hit rate segment
- Read assistant usage entries from `ctx.sessionManager.getEntries()` during footer rendering.
- Calculate the latest rate as `cacheRead / (input + cacheRead + cacheWrite) * 100`.
- Round the rate to an integer and render it as `CH87`, without a decimal fraction or percent sign.
- Render the segment after the model segment and before context projection status in the main footer.
- Render the segment after the model and before context usage in the selected-session header on the subagent management screen.
- Hide the segment until the displayed session contains cache read or cache write activity.

### SOL-02: Configuration
- Define the footer configuration contract in `pi-package/shared/footer-config.ts`.
- Read the shared contract from both the footer and `run-subagent` extensions.
- Add the optional boolean `showCacheHitRate` footer setting.
- Enable `showCacheHitRate` when the setting is omitted.
- Do not render the cache hit rate when `showCacheHitRate` is `false`, the footer is disabled, or the footer configuration is invalid.

### SOL-03: Validation
- Test both omitted and explicitly enabled `showCacheHitRate` settings.
- Assert the complete ordered footer segment list for normalized assistant usage with 874 cached tokens out of 1,000 prompt tokens.
- Assert that the selected subagent header renders `CH87` between model and context usage for the same normalized usage.

## Overengineering and Overspecification Considerations
- Both displays read Pi's normalized usage fields and do not parse provider responses.
- The calculation follows Pi's native footer behavior and adds no persistent state or event listener.
- One shared configuration module prevents the footer and subagent management screen from interpreting `showCacheHitRate` differently.

## Open Questions

None.

## References
- REF-01: `pi-package/extensions/footer/index.ts` - custom footer rendering.
- REF-02: `pi-package/shared/footer-config.ts` - shared footer configuration contract.
- REF-03: `pi-package/extensions/run-subagent/management-screen/screen.ts` - selected subagent header composition.
- REF-04: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/footer.js` - Pi's native cache hit rate calculation.
