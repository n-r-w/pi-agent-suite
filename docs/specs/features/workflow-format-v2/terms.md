# Terms

- Stage goal: The state that must hold when a stage ends, for example "the user confirmed the technical solution after seeing its text". A stage goal names no actions.
- Stage task: The actions that the agent performs to reach the stage goal, for example "compose the technical solution and show it to the user". Finishing the stage task does not complete the stage: the stage is complete when its goal state holds.
- Known stage: A stage whose prompt the extension has already published in the current provider-visible context segment and that has not changed since.
- Inline entry: A stage entry record that contains the complete stage prompt. The extension publishes it for the initial stage on workflow activation and for any other stage on its first entry.
- Reuse entry: A stage entry record for a known stage. It contains the stage ID and the available transitions, without the stage prompt.
- Rework transition: A transition of type `rework` that returns the agent to an earlier stage of the route.
- Transition ground: A condition under which the agent takes one transition. It has an ID and a condition text, which states a criterion and, where useful, an example, for example "a unit needs an approach that the technical solution does not have, for example a fix of existing code that needs a new mechanism".
- Unconditional transition: The only `advance` transition of a stage when it declares no grounds. The agent takes it when the stage is complete.
- Workflow format version: The version of the workflow definition format that one workflow declares. It determines which stage and transition fields the definition holds and which of them are required.
