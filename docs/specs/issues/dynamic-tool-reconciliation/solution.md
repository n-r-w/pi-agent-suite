# Solution

Keep the last active list produced by composition. Before each reconciliation, compare that list with Pi's current active list. Add only newly observed registered names to the baseline and remove names explicitly deactivated since the last application. Then run the existing remove-only main-agent and named filters over the baseline. Policy-hidden tools remain in the baseline because they were absent from the last applied list, not externally deactivated. Owner replacement removes retired names before reconciliation. Retired names cannot be re-adopted from an external activation, even when Pi still lists them as registered. An explicit baseline publication or owner contribution can reintroduce a retired name.

An external deactivation of a tool already hidden by policy cannot be observed through `getActiveTools()`. The composition preserves that hidden baseline name until its owner replaces it or the restriction lifts.
