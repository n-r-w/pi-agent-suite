# Technical Solution: Footer Cache Hit Rate

## Problem Statement
- PRB-01: The custom footer replaces Pi's native footer but does not display the latest prompt cache hit rate available in assistant usage data.

## Proposed Solution

### SOL-01: Cache hit rate segment
- Read assistant usage entries from `ctx.sessionManager.getEntries()` during footer rendering.
- Calculate the latest rate as `cacheRead / (input + cacheRead + cacheWrite) * 100`.
- Round the rate to an integer and render it as `CH87`, without a decimal fraction or percent sign.
- Render the segment after the model segment and before context projection status.
- Hide the segment until the session contains cache read or cache write activity.

### SOL-02: Configuration
- Add the optional boolean `showCacheHitRate` footer setting.
- Enable `showCacheHitRate` when the setting is omitted.
- Do not render the cache hit rate when `showCacheHitRate` is `false`.

### SOL-03: Validation
- Test both omitted and explicitly enabled `showCacheHitRate` settings.
- Assert the complete ordered footer segment list for normalized assistant usage with 874 cached tokens out of 1,000 prompt tokens.

## Overengineering and Overspecification Considerations
- The footer reads Pi's normalized usage fields and does not parse provider responses.
- The calculation follows Pi's native footer behavior and adds no persistent state or event listener.

## Open Questions

None.

## References
- REF-01: `pi-package/extensions/footer/index.ts` - custom footer configuration and rendering.
- REF-02: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/footer.js` - Pi's native cache hit rate calculation.
