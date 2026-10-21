# Technical Solution: System prompt by kind of agent session

## Problem Statement
[problem.md](problem.md). Requirements are in [requirements.md](requirements.md), with the original wording and template constraints in [prd.md](prd.md). Runtime observations are in [facts.md](facts.md).

## Proposed Solution

### Template representation and session kind
Represent a loaded template as ordered text parts, each applicable to both process kinds or to one kind. The existing ready, disabled, and invalid template states remain the lifecycle boundary. The template belongs to one Pi process; no shared mutable storage or cross-process synchronization is introduced.

Reuse the shared child-process marker reader through an extension-local environment module, as other extensions do. Determine the kind when the extension loads. The shared marker identifies both run-subagent children and council participants. A council participant's custom prompt takes precedence over this classification.

This meets FRQ-01 and FRQ-02 without a second copy of the common rules. The approved markers are `{{#mainAgent}}` with `{{/mainAgent}}`, and `{{#childAgent}}` with `{{/childAgent}}`. Unmarked text applies to either kind. For example, the fixture `C{{#mainAgent}}M{{/mainAgent}}{{#childAgent}}S{{/childAgent}}` yields `CM` in a main process and `CS` in a child process.

### Template boundary validation
Parse and validate sections when the template is loaded. Reject unmatched, mismatched, nested, and unknown-kind markers through the existing invalid-template diagnostic path. When invalid, the extension retains Pi's original prompt, as the approved solution requires. Unknown ordinary variables retain their existing warning and removal behavior.

Remove an entire marker-only line, including its newline, while retaining inline surrounding text. Retain original LF or CRLF text in all selected parts. This permits byte-preserving main-agent output under NRQ-01 and preserves section-free custom templates under NRQ-02. Substitute variables only after selecting parts, so inserted runtime values are not interpreted as section syntax. Rendering ordinary variables retains the formatter received from main, including visible active-tool guidelines.

### Custom prompts and tools
The existing ready-template handler still reconciles active tools. For a truthy custom prompt in Pi's prompt options, it returns no replacement. Pi's own prompt construction therefore retains custom prompts from CLI `--system-prompt`, a trusted project's `.pi/SYSTEM.md`, and the Pi agent directory's `SYSTEM.md` with either template source, meeting FRQ-05. An empty custom-prompt string follows Pi's own truthy custom-prompt semantics and uses the template.

Real Pi probes establish that all custom-prompt sources enter this option, including the actual council child. Selected-agent and tool prompt contributions remain owned by runtime composition. The feature does not modify that component or bypass tool reconciliation.

Before UNT-01, the extension returned its template even when Pi had a custom prompt. The handler now preserves Pi's prompt for every custom-prompt source through the same condition. The handler requires no retry, extra flag, or council-specific exception.

### Bundled rule placement
Wrap goal guard, scope control, and user communication in main-agent sections. Place the approved child-only defect-reporting block at scope control's position. Preserve all other text and block order. Use the exact rule 3 and child-block text in `prd.md`, meeting FRQ-03 and FRQ-04.

A one-time comparison of selected main-agent template text against the Git baseline, with only the approved rule substitution, verifies NRQ-01. This is a manual implementation check, separate from behavior tests. Behavior tests use synthetic fixture text and verify template logic only.

### Documentation
Update `docs/extensions/system-prompt.md` with the custom-prompt sources, process-kind sections, validation behavior, and bundled rule groups. Qualify the README extension description with the custom-prompt exception. These changes meet FRQ-06 and keep the package description consistent.

### Alternatives and costs
A design built with these requirements from the start would select role-specific sections in one template and leave custom prompts to Pi. The smallest change to the existing renderer has the same shape. Two complete template files would duplicate common rules; a general template engine would add a dependency and unrelated syntax. Neither is needed.

The chosen syntax reserves section-style placeholders for the two process kinds. A malformed section now invalidates a configured template. This is the validation and compatibility behavior already specified in the confirmed solution. A custom template without these markers retains its rendering behavior. An old package version treats new markers as unsupported variables and renders both bodies, so users adding markers must use the updated package.

## Overengineering and Overspecification Considerations
Each addition has a requirement: the process-kind reader and ordered parts meet FRQ-01/02; boundary validation prevents malformed role selection; the custom-prompt condition meets FRQ-05; bundled text meets FRQ-03/04; documentation meets FRQ-06. Existing tool reconciliation and variable substitution meet preservation constraints. Parsing at load is the approved data representation, not a new performance optimization claim.

No new configuration key, dependency, process marker, prompt file, generalized templating language, or shared storage is introduced. Module names, diagnostic wording, parser mechanics, and fixture layout remain implementation choices. Project validation will use the versions already declared by the rebased lockfile; dependency declarations and lockfiles stay unchanged.

## Open Questions
None. QST-01 was resolved during fact collection. Post-implementation probes will repeat CLI, project, agent-directory, and actual council child checks, recording runtime prompts and active tools before any model request.

## References
- [solution.md](solution.md) - original approved design.
- [target-picture.md](target-picture.md) - confirmed scope and authority.
- `pi-package/extensions/system-prompt/index.ts` - load, render, and handler boundaries.
- `pi-package/shared/child-agent-environment.ts` - shared classification.
- `pi-package/shared/agent-runtime-composition.ts` - tool reconciliation and agent prompt contributions.
