# Problem statement

## Context

The maintainer is upgrading Pi Agent Suite from Pi 1.1.0 to Pi 1.2.0. Users load the package in Pi and run its extensions in main and child sessions.

## Observed problem

Against Pi 1.2.0, the original startup integration tests fail before they can verify agent initialization. Compatibility of the remaining extensions also needs assessment.

## Affected audience

Package maintainers and users running the extensions on Pi 1.2.0.

## Evidence

- Initial isolated validation passed 1691 tests, skipped one, and failed two tests in `test/integration/main-agent-startup-barrier.test.ts`.
- TypeScript reported three calls with an outdated argument list in that file.
- The Pi 1.2.0 release changes startup events, session busy state, theme validation, and MCP resource reporting.

## Impact

Maintainers cannot use the failing test suite to establish package readiness for Pi 1.2.0.

## Current state

The original dependency declarations pin Pi 1.1.0. The isolated assessment identifies a test API incompatibility and supplies compatibility evidence for the exercised extension paths.

## Desired state

Maintainers can validate the package on Pi 1.2.0, and users can continue using the exercised extension functionality.

## Problem boundary

The problem concerns host-version compatibility across the package extensions and their shared runtime, including main-agent startup and child sessions.

## Open questions

None. External provider, clipboard, and terminal-specific behavior remains outside the isolated verification evidence.
