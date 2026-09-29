# Problem Statement

## Context

The repository uses root development dependencies to test extensions and exact peer dependencies in `pi-package/package.json` to define the published package contract.

## Observed Problem

Running `make pi-update PI_VERSION=<version>` updates the root Pi development dependencies but leaves the published package peer dependencies on the previous version.

## Affected Audience

Maintainers who update Pi dependencies and users who install a subsequent `pi-agent-suite` release.

## Evidence

After running the target for `0.87.1`, root `package.json` contained Pi `0.87.1`, while `pi-package/package.json` and `pi-package/package-lock.json` still contained Pi `0.87.0`.

## Impact

Repository validation uses a different Pi version from the exact peer version required by the published package. A release can therefore advertise an untested dependency contract or reject the Pi version used during repository validation.

## Current State

The target runs `bun add --dev --exact` only at the repository root. It then deletes `pi-package/bun.lock` and runs `bun install`, which does not change versions declared in `peerDependencies`.

## Desired State

One `pi-update` invocation leaves the root development dependencies, published peer dependencies, and both package lock formats on the requested Pi version.

## Problem Boundary

The problem covers synchronization of the four Pi packages listed in `PI_PACKAGES`. It does not cover unrelated dependency upgrades.

## Assumptions

None.

## Open Questions

None.
