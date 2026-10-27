# Terms

- Active tools: the tools that pi offers to the model in the current request.
- Toolset: a named group of deferred tools that the agent activates through `activate_toolset`.
- Prompt cache: a provider cache of previously submitted request prefixes. The provider bills cached input at a lower price than new input.
- Cache miss: a request for which the provider reports substantially less cached input than the context submitted in the preceding request.
