# Problem Statement

## Context

Pi stores model responses and token usage inside individual local sessions. Pi Agent Suite also maintains separate subagent sessions and records costs of selected auxiliary model requests. It has no independent historical usage store.

The current footer summarizes regular assistant cost in the open root Pi session and costs from five currently supported helper sources. It omits subagent-session cost and other auxiliary model paths. The `/subagents` screen shows the current or selected subagent session. Neither interface provides complete current-session-family or historical usage across multiple main-agent and subagent processes.

## Observed Problem

A Pi Agent Suite user cannot inspect complete model consumption across a current root session family or historical main-agent and subagent sessions in one place. Usage is not recorded in one independent, queryable history and cannot be compared by session scope, agent, model, provider, or time period through the existing interface.

## Affected Audience

Developers who use Pi Agent Suite with multiple main agents, subagents, models, or providers and want to understand historical model consumption.

## Evidence

- `pi-package/extensions/footer/index.ts` aggregates cost only from the open session.
- The footer calculates cache hit rate from the latest assistant response.
- `pi-package/extensions/run-subagent/management-screen` presents one selected subagent session.
- Pi session entries contain provider, model, token usage, cache usage, and estimated cost.
- The requested analysis spans local history rather than only the active session.

## Impact

Users cannot:

- compare consumption between agents and models;
- understand how consumption changes over time;
- identify which agents cause the most token processing or estimated cost;
- assess the scale of cache use and cache savings;
- obtain one local view of attributable regular and auxiliary model requests without rescanning conversation history.

## Current State

Main-agent and subagent usage is stored in separate local Pi sessions. Standard model responses contain detailed token and cost data. Existing main-agent sessions do not persist a per-session `agentId`. Auxiliary model requests are recorded separately and currently retain cost but not a complete token breakdown.

Pi Agent Suite has no independent usage history or historical usage view.

## Desired State

A Pi Agent Suite user can understand current-session-family and historical model consumption by agent and model from complete usage events recorded in an independent local store, including all identified auxiliary model paths, processed tokens, cache use, cache savings, estimated cost, and each model's cost share. The main footer uses the same current-session-family cost instead of a separate partial calculation.

## Problem Boundary

The problem covers:

- independent local usage events recorded by Pi Agent Suite;
- main agents and subagents identified by stable `agentId`;
- an explicit no-agent group for complete requests without a selected agent;
- regular requests and all identified auxiliary model-request paths;
- persisted root-session-family identity for main and nested subagent processes;
- requests with complete session, token, model, and cost data;
- current-session-family and all-session consumption over a selected period;
- provider- and model-level consumption and model cost share.

Provider billing records, subscription utilization, importing prior session history, and requests not recorded as complete usage events are outside the problem boundary.

## Assumptions

- The local usage store remains available for the period being analyzed.
- Available model pricing metadata is sufficient to estimate `Cache savings` for included requests.

## Open Questions

None at the problem-definition level. Decisions about model grouping, time ranges, navigation, layout, and aggregation belong to the PRD.

# Domain Glossary

- **Agent:** A configured main-agent or subagent type identified by a stable `agentId`, independent of its individual invocations and sessions.
- **Main agent:** An agent that owns a top-level Pi session.
- **Subagent:** An agent invoked from another agent through the subagent system.
- **Agent invocation:** One execution of an agent prompt under an agent identity.
- **Agent session:** Persisted Pi conversation history associated with an agent.
- **Model request:** One request sent to a model provider that produces usage data.
- **Auxiliary model request:** A non-regular model request from `consult-advisor`, `context-projection`, `convene-council`, `custom-compaction`, `subagent-query`, `ask-llm`, `vision`, `knowledge`, native compaction, or native branch summarization.
- **Agent consumption:** Consumption from regular model responses and auxiliary model requests attributed to the agent.
- **No agent:** The explicit TUI group for complete model requests made without a selected `agentId`.
- **Root session family:** One root Pi session, every direct or nested subagent session launched under it, and their included auxiliary model requests.
- **Provider:** The service that executes a model request.
- **Model:** The provider model that executes a model request.
- **Local usage store:** The Pi Agent Suite storage that persists complete usage events independently of conversation sessions.
- **Historical usage:** Aggregated consumption derived from the local usage store for a selected time range and session scope.
- **Current session:** The root session family active when `/usage` opens.
- **Cost share:** One model row's cost divided by the visible total cost for the selected range, session scope, and agent.
- **Input tokens:** Non-cached tokens supplied to a model in Pi-normalized usage data.
- **Output tokens:** Tokens generated by a model.
- **Cache read:** Input tokens reused from a provider cache.
- **Cache write:** Input tokens added to a provider cache.
- **Processed tokens:** The combined `input`, `output`, `cacheRead`, and `cacheWrite` token volume.
- **Cache savings:** The non-negative API-price amount saved because `cacheRead` tokens were charged below the ordinary input rate.
- **Cost:** Estimated API-price cost of model consumption. The value does not represent a provider invoice or subscription charge.
- **Time range:** The historical interval included in a usage view.
