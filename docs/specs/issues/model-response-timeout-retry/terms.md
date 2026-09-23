# Terms

- Response timeout: Expiry of the total model-response duration configured for `model-response-timeout`.
- Initial request: The first provider request in one sequence of attempts.
- Retry: One additional provider request after a response timeout. The initial request is not a retry.
- Retry limit: The maximum number of retries after the initial request.
- Child invocation: A `run-subagent` call that starts a child Pi process and observes its RPC events.
- Settlement: Pi's `agent_settled` event at the end of one agent run.
