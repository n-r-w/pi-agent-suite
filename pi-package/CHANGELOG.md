# Changelog

## [Unreleased]

### Fixed

- Restore the workflow stage and transition graph after compaction and when resuming older compacted sessions. Checkpoints omit the graph when it is already visible in the model context.

## [2.21.1] - 2026-11-02

### Added

- Package changelog for Pi's "Extension Updates" notices after future package updates.
- Patch, minor, and major release preparation checks for a nonempty changelog entry for the target version before installing dependencies or running tests.

### Changed

- Require Pi 1.5.0. Update Pi before installing this release.

## [2.21.0] - 2026-11-01

### Added

- Configurable WebSocket transport for OpenAI Responses requests through the `openai` provider.
