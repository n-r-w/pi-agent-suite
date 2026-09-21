# Technical Solution: Migration to Pi 0.87.0

## Problem Statement

See `problem.md`. Requirements are defined in `prd.md`, and domain terms are defined in `terms.md`.

The migration must make each affected component fulfill its purpose under Pi 0.87.0. It does not need to reproduce Pi 0.86.1 internal algorithms or every secondary behavior detail.

## Proposed Solution

### Core approach

Use the effective context produced by Pi 0.87.0 as the source of truth:

- the main agent, auxiliary requests, and custom compaction use effective context;
- council participants receive raw session history;
- the footer and `compaction-trigger` use an estimate that accounts for active context projection.

An isolated Pi 0.87.0 experiment found failed event mapping, stale replay after context edits, one exhaustive-switch TypeScript error, and one integration assertion based on Pi 0.86.1 event contents. A minimal prototype using `buildSessionProjection()` passed typecheck, checks, and the full behavior suite except the existing skipped test.

### D4: Dependencies

- Set `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` to exact version `0.87.0` in both package manifests.
- Synchronize `bun.lock`, `pi-package/bun.lock`, and `pi-package/package-lock.json`.
- Check that both the repository root and `pi-package` resolve the four packages to `0.87.0`.
- Do not add Pi 0.86.1 compatibility.
- Keep the direct `typebox` version unless target-version typecheck reports a separate incompatibility.

### D5: Shared effective-context mapping

Change `buildContextEntryMapping()` to use Pi `buildSessionProjection()`.

- An omitted target contributes no message.
- A replaced target contributes Pi-normalized replacement content.
- Every projected message keeps its `sourceEntry` association.
- Compaction and context-edit rules remain owned by Pi.

Live projection, auxiliary replay, and custom compaction use this shared mapping instead of separate context-edit implementations.

### D6: System-free context events

Keep context projection on the `context` event.

- Exclude system-role messages from the canonical sequence used for event-to-entry matching.
- Keep strict matching for all conversation messages.
- Keep the existing persisted provider-error handling.
- Do not move projection to `context_with_system`.

Pi remains responsible for the system prompt and tool declarations.

### D7: Projection and context-edit ordering

For one source entry, later session state determines the effective result:

- a context-projection entry records a shortened representation;
- a later `context_edit` invalidates that older representation;
- a later context-projection entry can shorten the edited content again.

Apply this ordering to persisted state, live state, replay, and savings calculation. Runtime state must not restore a projection replacement that the active branch invalidated.

### D7.1: Projection-aware usage

The footer and `compaction-trigger` need a decision-useful estimate, not the Pi 0.86.1 accounting algorithm.

Use two modes:

1. When the latest model response is after the latest `context_edit` or compaction, its usage already includes projections active before that response. Subtract only projection savings created after the response.
2. When a `context_edit` or compaction is after the latest model response, Pi estimates canonical context again. Subtract all effective active projection savings from that estimate.

Additional rules:

- preserve `tokens: null`;
- clamp adjusted tokens to zero;
- exclude invalidated projection state;
- recalculate after a successful model response;
- keep `compaction-trigger` thresholds unchanged.

Derive the mode from the public session projection and active branch. Do not import private Pi implementation modules.

### D8: Auxiliary requests

The following consumers use shared effective-context replay:

- `subagent_query`;
- `ask-llm`;
- `consult-advisor`;
- knowledge accumulation;
- custom compaction.

At each auxiliary boundary, remove main-agent system messages, use the auxiliary system prompt, and expose no main-agent tools.

### D9: Custom compaction

- Exclude tool results omitted from effective context.
- Use replacement content instead of original content.
- Do not generate source summaries from stale tool-result content.
- Keep existing candidate-size, tool-call, and summary-generation rules.

The pre-existing repeated-compaction retained-context defect is outside this migration.

### D10: Raw council context

Council continues to use raw session history.

- Add `case "context_edit"` to `renderContextEntry()` and return no block for the edit entry.
- Continue rendering the raw target entry.
- Do not add a default switch branch.

### D11: Compaction integration

Update `test/integration/compaction-overflow-retry.test.ts` for system-free `ContextEvent.messages`.

Keep checks for:

- one interruption;
- one compaction;
- one hidden continuation;
- two provider requests;
- successful settlement.

Replace the Pi 0.86.1 absolute event-message token assertion with relative growth before compaction and reduction after compaction.

### Areas without production changes

Do not change production behavior for:

- workflow settlement;
- `TurnEndEvent` and `AgentBeforeSettleEvent`;
- `SessionManager` restoration;
- `shouldStopAfterTurn`;
- vision image processing;
- `context_with_system`.

The Pi 0.87.0 experiment found no failure of these component purposes.

### Behavior tests

Follow RED-GREEN-REFACTOR.

#### RED

Add or update behavior checks for:

1. Main-agent projection omits an edited target and uses replacement content.
2. Projection maps a branch with system messages to a system-free `context` event.
3. Auxiliary replay uses effective context, its own system prompt, and no tools.
4. Custom compaction excludes omitted or stale tool-result content.
5. Council keeps raw evidence and ignores the context-edit record itself.
6. After a recovery context edit, active projection still affects footer usage and the `compaction-trigger` decision.
7. The real compaction lifecycle completes successfully.

Tests compare roles, decisions, source-entry relationships, and transformed structures. They do not assert system-prompt text.

#### GREEN

- Use `buildSessionProjection()` for shared mapping.
- Match system-free context events.
- Apply append-order precedence to projection and context-edit state.
- Implement the two projection-aware usage modes.
- Handle `context_edit` in council rendering.
- Update dependency declarations and lock files.

#### REFACTOR

- Remove obsolete context-builder imports.
- Keep one shared effective-context mapping.
- Do not add a compatibility layer or a local copy of Pi context algorithms.

### Documentation

Update only affected statements in:

- `docs/extensions/context-projection.md`;
- `docs/extensions/custom-compaction.md`;
- `docs/extensions/convene-council.md`.

Describe the distinction between effective context and raw session history.

### Final verification

Run:

- `bun run verify`;
- resolved-version checks in the repository root and `pi-package`;
- single-extension loading for affected extensions;
- whole-package loading;
- runtime omission and replacement checks;
- the real compaction lifecycle;
- the projection → recovery edit → `compaction-trigger` decision scenario.

Use temporary working directories and state. Do not use real user files, models, network calls, or sessions.

## Overengineering and Overspecification Considerations

- The solution uses public `buildSessionProjection()` rather than reproducing Pi context construction.
- One shared mapping serves all effective-context consumers.
- The solution does not require exact Pi 0.86.1 behavior.
- The solution adds no storage format, compatibility layer, or private Pi import.
- The solution excludes the separate repeated-compaction defect.
- Components without a failed user scenario remain unchanged.

## Open Questions

None.

## References

- `problem.md` - approved problem statement.
- `terms.md` - domain terminology.
- `prd.md` - approved user scenarios and requirements.
- `pi-package/shared/context-projection.ts` - shared mapping, replay, and savings.
- `pi-package/extensions/context-projection/index.ts` - live projection and usage synchronization.
- `pi-package/extensions/custom-compaction/compaction-source-projection.ts` - custom-compaction source projection.
- `pi-package/extensions/run-subagent/subagent-query.ts` - persisted query replay.
- `pi-package/extensions/convene-council/context.ts` - raw council context.
- `test/integration/compaction-overflow-retry.test.ts` - real compaction lifecycle.
- [Pi 0.87.0 release notes](https://pi.dev/news/releases/0.87.0) - target-version changes.
- [Pi session format](https://pi.dev/docs/latest/session-format) - canonical projection and context edits.
- [Pi extension events](https://pi.dev/docs/latest/extensions) - context and lifecycle contracts.
