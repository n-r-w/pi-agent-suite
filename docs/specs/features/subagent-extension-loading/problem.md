# Problem statement

## Context

Pi can discover user and project extensions and load built-in extensions. Subagent definitions separately select allowed tool names.

## Observed problem

Subagent users could not choose which additional extensions a child Pi process loaded. A reported `SubAgentExtractor` launch failed with `tool pattern codemode did not match any available tool`, despite `codemode` appearing in the agent's allowed tools and enable-tools configuration.

## Affected audience

Users who run agents through `subagent_start` and continue saved sessions through `subagent_steer`.

## Evidence

The reported launch on 2026-10-03 failed before accepting the child prompt. An isolated Pi 1.0.0 check showed that `--no-extensions` removed `codemode` from the registered tool catalog even with `defaultTools: ["+codemode"]`. Explicitly loading `builtin:codemode` restored the tool.

## Impact

A configured agent cannot start when its tool policy requires a tool supplied by an unloaded extension.

## Current state

The reported launcher passed `--no-extensions` and explicitly loaded `pi-package`. Users had no subagent extension-loading setting.

## Desired state

Users can choose a child's additional extensions independently of the child's allowed tools. Ordinary Pi extension settings remain usable without an implicit package-only restriction.

## Problem boundary

Extension loading for new, nested, and resumed run-subagent workers. Auxiliary model calls and other package child launchers are separate behaviors.

## Open questions

None.
