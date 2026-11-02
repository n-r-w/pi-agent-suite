# Technical solution: Package changelog

## Problem statement

See the [problem statement](problem.md).

## Proposed solution

Keep `CHANGELOG.md` in `pi-package/` and include it in the manifest's `files` list. Pi's default changelog path resolves to this file after installation, so `pi.changelogPath` is unnecessary.

Record current user-facing work under `## [Unreleased]`. Record the published OpenAI WebSocket addition under `## [2.21.0] - 2026-11-01`, based on that GitHub Release. Older releases remain available on GitHub.

Add authoring rules to `AGENTS.md` and release instructions to `docs/PUBLISHING.md`. Before an approved release command, maintainers move unreleased entries to a section with the target package version and release date. They retain an empty unreleased section and published history.

Pi's parser ignores the unreleased section and reads numbered version headings. On first discovery, Pi records the installed version. On a later fresh interactive launch, Pi shows entries newer than the recorded version. Resumed sessions skip these notices. Users control the `collapseChangelog` setting.

The release runner checks the target version's section before installing dependencies or running tests. It calculates the patch, minor, or major target from the current package version. A missing file, missing section, or section with no description causes an error. The check reads the changelog and leaves its contents unchanged. Validation without a version change does not require a future release entry.

## Overengineering and overspecification considerations

The feature adds package data, maintenance instructions, and a read-only check at the start of release preparation. Pi provides the notification UI, version tracking, and parsing. An isolated npm-pack test checks archive inclusion without checking agent instruction content.

## Validation

The npm-pack test fails with the original manifest because its file list excludes `CHANGELOG.md`. With the updated manifest, the test passes.

A separate npm archive built from the actual manifest's file list contains `package/CHANGELOG.md`. Pi 1.5.0's parser reads its `2.21.0` section, excludes the unreleased entries, returns `2.21.0` for a recorded version of `2.20.0`, and returns no entries for a recorded version of `2.21.0`. Temporary staging files and the archive are removed.

`bun run verify` with the repository-local Pi 1.5.0 CLI passes 2086 tests, skips one existing test, and reports zero failures. TypeScript, Biome checks of 479 files, Go tests, formatting checks, and Go vet pass. The release-runner tests cover accepted target entries and rejected missing or empty entries for patch, minor, and major versions, with fake package-manager commands and temporary fixture files. Missing or empty entries prevent every external command for all three release kinds. `make release-next-steps` includes the changelog in its suggested release commit.

## Open questions

None. This feature does not reconstruct earlier changelog entries or automatically edit release notes.

## References

- [Critical requirements](prd.md)
- [Pi package changelogs](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/packages.md#show-a-changelog)
- [Pi Agent Suite 2.21.0](https://github.com/n-r-w/pi-agent-suite/releases/tag/v2.21.0)
