# Problem statement

## Key definitions and abbreviations

See [terms](terms.md).

## Context

Pi 1.5.0 can show versioned package changes under "Extension Updates" after an update. Pi Agent Suite already publishes GitHub Release notes.

## Observed problem

The package has no changelog file, so users cannot see package changes through Pi's extension-update notices. Agents also lack instructions for maintaining those entries.

## Affected audience

Package users reviewing updates and contributors preparing changes and releases.

## Evidence

The original `pi-package/package.json` contains no changelog path or changelog entry in its `files` list. An isolated npm-pack test excludes a fixture `CHANGELOG.md` with that manifest.

## Impact

Users must visit GitHub Releases to learn what changed. Contributors have no repository rule requiring a package changelog entry.

## Current state

The implementation adds the default changelog file, package inclusion, and authoring and release rules. See [technical solution](solution.md).

## Desired state

Users can read released changes through Pi's native update notices, and agents maintain the changelog with each user-facing change.

## Problem boundary

The feature concerns package release information and its publication. It preserves extension runtime behavior.

## Assumptions

The isolated checks use the package's supported Pi 1.5.0 host.

## Open questions

None.
