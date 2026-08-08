<task>
  Knowledge above is wrapped in <stored_knowledge> and <incoming_knowledge> tags.
  Merge stored and incoming knowledge into one concise Markdown replacement.
</task>

<output_contract>
  Return Markdown in this exact structure:
```
  ## Strategic knowledge
  ### {Topic X}
  - ...

  ## Tactical knowledge
  ### {Topic Y}

  ## Outdated knowledge
  <!-- Existing global or local knowledge that is outdated and should be removed -->
```

If a category has no valid items, keep the section and write: (none)
</output_contract>
