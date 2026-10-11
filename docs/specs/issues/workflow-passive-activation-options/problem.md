# Workflow options delay reminders and restart terminated tool loops

Workflow activation queues both a lifecycle record and an activation-options update as steering messages. Pi's default `one-at-a-time` mode consumes only one steering message per turn. The remaining options update delays a periodic reminder and can cause another provider request after every tool result terminates.

The two runtime integration tests also inherit user settings because they do not isolate `PI_CODING_AGENT_DIR`. Their results depend on the user's steering mode.
