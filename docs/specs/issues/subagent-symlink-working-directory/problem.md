# Problem statement

## Key definitions and abbreviations

See [Terms](terms.md).

## Context

Subagents can choose another working directory and delegate further through relative paths.

## Observed problem

When a caller's directory contains a symlink, lexical path normalization can select a different directory from filesystem traversal. A nested child can consequently start in another existing project.

## Affected audience

Callers that launch subagents through symlink paths and use relative directories containing `..`.

## Evidence

A fixture has `alias` pointing to `projects/parent`, with both `projects/sibling` and `sibling` present. Before the fix, starting the parent through `alias` and its child through `../sibling` selected `sibling`. The regression tests reproduce this through new and continued parent invocations.

## Impact

HIGH. A successful child invocation can work with files in an unintended project. The tests verify directory selection and perform no destructive operations.

## Current state

The supervisor resolves physical directories before nested path calculation. Project-registry and pending-tool presentation comparisons use the same directory resolution.

## Desired state

Relative directory requests follow the caller's physical working directory, including after continuation.

## Problem boundary

Symlink resolution for process directories, project-registry comparison, and directory presentation. Permission checks and model-error precedence remain outside this fix.

## Assumptions

No assumptions.

## Open questions

None.
