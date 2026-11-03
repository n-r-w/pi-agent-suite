Request a transition of the active workflow before starting work on another stage. If the transition names a bound workflow, the extension starts that check first and keeps the parent on its current stage. Exit the check with boolean `allow` to decide the pending transition.
Select the target only from `<available_transitions>`.
Provide a nonempty free-text `basis` stating the facts that justify the transition, for every workflow format.
When the selected transition declares grounds, also supply one of its declared ground IDs in `ground`; otherwise omit `ground`.
