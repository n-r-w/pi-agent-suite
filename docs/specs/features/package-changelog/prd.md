# Idea: Package changelog

## Definitions

See [terms](terms.md).

## Context and problem

See the [problem statement](problem.md).

## Goal

Show released package changes through Pi's native extension-update notices and keep that information current through repository rules.

## Affected scenarios

Agents complete user-facing changes. Maintainers prepare a release. Users update the installed package and start a fresh Pi session.

## Scope and non-scope

Scope includes the changelog, npm package contents, agent rules, publishing instructions, and package verification. Custom notification UI, automatic release-note generation, historical reconstruction of every release, package version bumps, and publication are outside this feature.

## Requirements

### Functional requirements

- [X] FRQ-01: The npm package SHALL contain a changelog at the default path that Pi reads.
  - Origin: package changelog proposal and approval.
  - Goal: Make release information available to Pi and package users.
  - Goal achievement: Full when the archive includes the file and Pi parses its released versions.
- [X] FRQ-02: Repository rules SHALL require an unreleased changelog entry for each user-facing change and manual promotion to the target package version before a release command runs.
  - Origin: request to add changelog authoring rules to `AGENTS.md`.
  - Goal: Keep entries current without inventing release numbers or changing published history.
  - Goal achievement: Full when agents and maintainers have explicit instructions.

- [X] FRQ-03: Before installing dependencies or running tests, each release command SHALL reject a missing changelog section for its target version or a section without a description. The check SHALL leave the changelog unchanged.
  - Origin: requirement to validate the entry when attempting a version change.
  - Goal: Block version changes until their release notes are ready.
  - Goal achievement: Full when all three release kinds stop before invoking any external command for an absent or empty entry.

### Non-functional requirements

- [X] NRQ-01: Package notifications SHALL use Pi's native changelog support without additional extension runtime code.
  - Origin: approved proposal to use native extension-update notices.
  - Goal: Avoid a second notification mechanism.
  - Goal achievement: Full when only package data and maintenance rules change production behavior.

## Critical scenarios

- SCN-01: A maintainer creates an npm archive. The archive includes `CHANGELOG.md`. Covers FRQ-01.
- SCN-02: Pi reads the changelog. Its parser includes numbered released sections and skips the unreleased section. Covers FRQ-01 and NRQ-01.
- SCN-03: A maintainer prepares a patch release from `2.21.0`. A nonempty `2.21.1` changelog section allows the version command; a missing or empty section blocks all external commands, including dependency installation and tests. Minor and major releases use their corresponding target versions. Covers FRQ-03.
- FRQ-02: No automated scenario. Review `AGENTS.md` and `docs/PUBLISHING.md`; tests must not assert agent instruction content.

## Open questions

None.

## References

- [Technical solution](solution.md)
- [Pi package changelogs](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/packages.md#show-a-changelog)
