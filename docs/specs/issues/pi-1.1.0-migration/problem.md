# Problem statement

## Context

The project is a set of Pi extensions. Its development dependencies and published-package peer dependencies pin Pi 1.0.2. The maintainer wants to move the project to Pi 1.1.0.

## Observed problem

The maintainer does not know whether all project functionality will continue to work without functional disruptions on Pi 1.1.0. Compatibility of the complete extension set has not been established.

## Affected audience

The maintainer cannot make an informed migration decision. Users of the extension set may encounter lost capabilities or unintended behavior changes after the update.

## Evidence

- The maintainer explicitly identified preservation of all extension functionality as the purpose of the migration assessment.
- `package.json` and `pi-package/package.json` declare Pi 1.0.2 for the four host-provided Pi packages.
- Preliminary isolated verification on Pi 1.1.0 passed 1676 behavior tests and skipped one test. Strict type checking reported incompatibilities in two test fixtures. Passing tests alone have not established preservation of the complete functionality.

## Impact

The maintainer cannot yet determine whether the update is safe or which observed incompatibilities affect extension functionality.

## Current state

The project remains on Pi 1.0.2. Preliminary checks provide evidence about some behavior paths on Pi 1.1.0. A compatibility conclusion for the complete extension set remains unavailable.

## Desired state

The maintainer knows, from evidence, whether Pi 1.1.0 preserves all project functionality. Any functional disruptions have been identified and explained.

## Problem boundary

The problem concerns the complete extension set and its shared functionality, extension interactions, and configuration-dependent behavior. One extension or one observed incompatibility does not define the boundary. Adoption of new Pi or extension capabilities is a separate question from preservation of project functionality.

## Open questions

None about the problem definition. Whether each part of the functionality works on Pi 1.1.0 remains the subject of the compatibility assessment.

## References

- [Terms](terms.md)
- `package.json`
- `pi-package/package.json`
- [Pi 1.1.0 release notes](https://pi.dev/changelog/releases/1.1.0)
