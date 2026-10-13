# Technical solution: Pi 1.2.0 migration

## Problem statement

See the [problem statement](problem.md). The startup integration fixture uses a Pi runner API that changed in 1.2.0.

## Proposed solution

- Pin the four host-provided Pi packages to 1.2.0 in both manifests. Use the existing `make pi-update PI_VERSION=1.2.0` target to update dependency declarations and lockfiles and validate the repository.
- Adapt the startup integration fixture to the new runner contract. Preserve its initialization barrier, recovery assertions, and runtime observations.
- Keep production extension code unchanged. The registered startup handlers use shared event fields that Pi provides for both user and custom-message runs.
- Update the supported host version in the README and record the validation evidence in the [implementation supplement](implementation.md).

## Overengineering and overspecification considerations

The migration needs no compatibility adapter, new dependency, or runtime fallback. Existing tests and isolated CLI probes cover the exercised compatibility paths.

## Open questions

None. The checks use a fake provider; they do not establish compatibility with every live provider or terminal environment.

## References

- [Critical requirements](prd.md)
- [Pi 1.2.0 release notes](https://pi.dev/changelog/releases/1.2.0)
- Repository update target in `Makefile`
