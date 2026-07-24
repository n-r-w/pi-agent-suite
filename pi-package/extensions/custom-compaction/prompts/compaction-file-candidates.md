<file_candidates>
<rules>
  1. Paths under `<read_files>` and `<modified_files>` were read or modified in the conversation being summarized. They are CANDIDATES for `<must_read_after_compaction>`, NOT REQUIRED summary content.
  2. Add a path to `<must_read_after_compaction>` only when its exact current contents must be loaded before continuing current work, executing a next step, or applying a retained constraint.
  3. MUST add every loaded `SKILL.md` path.
  4. Consider both lists. Modified file may require reloading because the checkpoint does not retain its exact current contents.
  5. MUST NOT add a path only because it appears here.
  6. When updating a previous summary, retain an existing `<must_read_after_compaction>` entry only while its exact contents remain required.
  7. MUST NOT copy these lists into the summary as-is.
  8. State why each non-skill path in `<must_read_after_compaction>` must be loaded.
  9. RELEVANT resources found in the conversation MUST BE added even when absent from these lists.
</rules>
<read_files>
{{readFiles}}
</read_files>
<modified_files>
{{modifiedFiles}}
</modified_files>
</file_candidates>
