# Problem

Runtime composition captures Pi's active tools once. When an external extension activates registered tools later, the next `before_agent_start` reconciliation restores the old list and drops those tools. Lazy MCP connections can stay ready while their tools disappear from the next turn.
