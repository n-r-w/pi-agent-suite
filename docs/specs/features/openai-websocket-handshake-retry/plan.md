# Delivery plan: WebSocket handshake recovery

Deliver the [accepted target](target-picture.md) in one pull request against `main`.

## Key definitions and abbreviations

See [Terms](terms.md).

## Delivery strategy

See [Technical solution](technical-solution.md#proposed-solution).

## Main changes

The extension gains configurable handshake recovery before sending a model request. The same change covers the acceptance scenarios, configuration documentation, and change log.

## Entities and invariants

See [Technical solution](technical-solution.md#proposed-solution).

## New folders and components

No new component is needed.

## Backward compatibility

See [Technical solution](technical-solution.md#proposed-solution) for the behavior that stays unchanged.

## Plan units

### Unit tree

UNT.01 is the only unit and has no dependencies.

### Decomposition justification

The registered provider stream exposes recovery, fallback, cancellation, and configuration through one entry point. A test with a controlled endpoint can verify the entire change without a temporary entry point or another unit.

## Overengineering and overspecification considerations

One slice covers the requested behavior. It adds no dependency or separate test infrastructure. The implementer chooses the control flow and fixture details.

### Unit UNT.01 - slice: Recover a failed handshake

#### Goal

Recover from temporary WebSocket handshake failures without changing how the extension handles a request after it sends it.

#### Behavior

See SCN.01–04 in [Requirements and critical scenarios](requirements.md#critical-scenarios).

#### Work

Status: Done in `31651a7`. Performer: SubAgentDeveloperRegular. Implement the [technical solution](technical-solution.md), starting with failing extension tests. Update the extension guide and the package change log. Work only in the isolated checkout.

#### Verification

Test in process through the registered provider stream with the existing fake Responses endpoint and HTTP transport. Exercise the approved scenarios, including the original deadline before HTTP starts, and verify that a failed acquisition after the first send still uses one attempt. Use the focused extension tests while making changes.

A SubAgentAnalyst checks code quality against the technical solution and decisions. After the unit, a SubAgentAnalyst checks the changed documents. SubAgentExtractor runs the project checks after the reviews. The `verify_implementation` stage checks the whole result against the acceptance scenarios. The `user_review` stage presents the whole result for acceptance.

#### Exit criteria

The new behavior passes the extension tests, the existing post-send cases remain unchanged, and the project checks show no new failures against the recorded baseline. Remove temporary code and pass the quality checks before handoff.

#### Relation

Independent.

#### Risks

HIGH: Applying the retry policy after the first send could change transport recovery for a model request that Pi already submitted. Check the existing post-send path and the failed replacement handshake.

## Test strategy

Use the existing in-process extension harness with local fixtures. Run `bun run verify` from the isolated checkout. If `verify` stops at a baseline failure, run the remaining checks independently and record the failing tests by name.

## Dependencies and resourcing

No new dependency is required. Use the installed dependencies copied to the isolated checkout.

## Project definition of done

The accepted scenarios pass, the extension guide describes the configuration and fallback, and the standalone pull request is ready to open after final review.

## Assumptions

None.

## Open questions

None.

## Standards deviations

The baseline `bun run verify` stops on two pre-existing `system-prompt` test failures. Do not change those tests as part of this work.

## References

- [Technical solution](technical-solution.md)
- [Decisions](decisions.md)
