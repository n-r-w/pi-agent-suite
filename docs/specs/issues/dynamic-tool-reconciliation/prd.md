# Requirements

- Preserve newly activated, registered external tools across user turns.
- Respect observed external deactivation and avoid adopting unregistered tool names.
- Apply main-agent and named restrictive policies to new tools. Restore policy-hidden baseline tools when restrictions lift.
- Preserve explicit owner replacement and removal of stale provider tools.
- Validate with focused unit tests and a real Pi CLI run using isolated state and a local fake provider.
