# Problem Statement

## Context

The `model-response-timeout` extension aborts a model response when its configured total duration expires. Pi 0.87 distinguishes cancellation of an agent run from a provider error eligible for automatic retry.

## Observed Problem

When the extension aborts a response after 600 seconds, the assistant records a timeout error but Pi does not repeat the request.

## Affected Audience

Users of main Pi sessions and `run-subagent` invocations that load the timeout extension.

## Evidence

In the observed session, the user message arrived at 22:04:44 UTC on 2026-09-22 and Pi recorded `Model response timed out after 600 seconds.` at 22:14:44 UTC. No automatic retry followed. Pi 0.87's `AgentSession.abort()` marks the agent run as cancelled before its retry decision.

## Impact

A single stalled provider response ends the user's request. In a child session, `run-subagent` reports failure when the first aborted agent run settles.

## Current State

The extension replaces the timed-out response with an empty error message. Pi's cancellation state prevents its built-in retry policy from acting on that message.

## Desired State

Users receive a result after a bounded retry of a timed-out request, or a final timeout error after the retry limit is exhausted.

## Problem Boundary

The problem occurs after the total response duration configured for `model-response-timeout` expires. It affects model requests in main and child Pi sessions, not tool execution or ordinary user cancellation.
