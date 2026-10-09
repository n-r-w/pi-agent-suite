# Idea: Pi 1.1.0 migration

## Definitions

See [terms.md](terms.md).

## Context and problem

See [problem.md](problem.md).

## Goal

Establish whether Pi 1.1.0 preserves all project functionality and identify changes needed to eliminate functional disruptions.

## Scenarios

- A maintainer evaluates compatibility of the complete extension set.
- Users retain the capabilities of individual extensions, shared functionality, and extension interactions after the Pi update.
- A maintainer distinguishes established compatibility, observed functional disruptions, and capabilities that remain unverified.

## Scope and non-scope

- Scope: the 26 extension entry points registered in `pi-package/package.json`, their capabilities, shared functionality including model aliases, extension interactions, and configuration-dependent behavior.
- Scope addition: correction of the pre-existing image-format mismatch in `vision` after compression.
- Non-scope: adoption of new Pi or extension capabilities and correction of the pre-existing passive context restoration failure during native overflow retry.

## Requirements

### Functional requirements

- [X] FRQ-01: All project functionality SHALL work on Pi 1.1.0 without functional disruptions, including shared capabilities and extension interactions.
  - Origin: source. The approved problem statement requires preservation of the complete functionality on the target Pi version.
  - Goal: Preserve the capabilities of the extension set.
  - Goal achievement: Full. Establishes the required functional outcome of the migration.
- [X] FRQ-02: The compatibility assessment SHALL provide a conclusion and supporting evidence for each project capability. It SHALL identify unverified capabilities explicitly; passing tests alone SHALL NOT imply compatibility of the complete project.
  - Origin: source. The approved problem concerns uncertainty about the complete functionality.
  - Goal: Give the maintainer an evidence-based compatibility conclusion.
  - Goal achievement: Full. Distinguishes established results from remaining uncertainty.
- [X] FRQ-03: Each proposed change SHALL identify the incompatibility or explicitly approved pre-existing defect it addresses and the project capability it preserves.
  - Origin: formulated. The approved compatibility requirement is extended by the user's approval to correct the pre-existing image-format mismatch.
  - Goal: Limit changes to compatibility findings and explicitly approved defect corrections.
  - Goal achievement: Partial. Makes each proposed change traceable to preservation of functionality.
- [X] FRQ-04: When `vision` processes an image, the image type sent to the model SHALL match the resulting image data, including after compression changes the format.
  - Origin: formulated. The user approved correction of the image-format mismatch after a PNG was converted to JPEG while retaining the PNG type.
  - Goal: Preserve image analysis with correctly identified image data.
  - Goal achievement: Partial. Eliminates the approved pre-existing mismatch. For example, a PNG converted to JPEG is sent as JPEG with the JPEG image type.

### Non-functional requirements

- [X] NRQ-01: Compatibility checks SHALL follow the project testing rules: isolated data and fakes for external dependencies, without real user files, real authentication, real models, or real network calls. Tests SHALL check logic rather than prompt content.
  - Origin: source. `AGENTS.md` testing rules and the approved validation requirement.
  - Goal: Assess compatibility without using or changing real user state or external services.
  - Goal achievement: Partial. Constrains how the evidence is collected.

## Open questions

None about the requirements. The compatibility status of each capability remains the subject of the technical investigation.

## References

- [Problem statement](problem.md)
- [Terms](terms.md)
- `pi-package/package.json`
- `AGENTS.md`
- `README.md`: extension capability overview.
- `docs/extensions/`: extension behavior and configuration.
- [Pi 1.1.0 release notes](https://pi.dev/changelog/releases/1.1.0)
