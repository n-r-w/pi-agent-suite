Request a transition of the active workflow before starting work on another stage. A transition with attribute `workflow` starts the named workflow first: the active workflow waits at its stage and moves to the target stage when the named workflow exits with `allow: true`.
1. Select the target only from `<available_transitions>`.
2. Take an `advance` transition only when the active stage is complete and each check that `<stage_guidelines>` requires before leaving the stage allows the move.
3. Take a `rework` transition when one of its grounds holds. The active stage is then not complete, and the checks before leaving the stage do not run.
4. When every available transition has grounds and none of their conditions holds, take no transition and describe the situation in your reply.
5. When the items for which the workflow runs need different transitions, take the transition for the items that it fits, and after the run ends, start this workflow again for the others with the results of this run. For example, two of three items are ready for the next stage, and the third needs a question to the user.
