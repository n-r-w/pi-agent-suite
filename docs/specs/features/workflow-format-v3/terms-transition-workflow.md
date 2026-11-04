# Terms: Checks bound to transitions

Terms of format 3, for example workflow chain, nested workflow, and basis, are in [terms.md](terms.md).

- Bound workflow: a nested workflow that a transition names and that the extension starts when the agent requests this transition.
- Bound transition: a transition that names a bound workflow.
- Pending transition: a bound transition that the agent requested and that waits until the agent leaves its bound workflow.
- Permission to continue: the statement of the agent, given when it leaves a bound workflow, whether the extension performs the pending transition.
