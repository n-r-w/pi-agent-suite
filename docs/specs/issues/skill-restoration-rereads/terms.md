# Terms

- Candidate paths: skill file paths that `skill-restoration` records when a compaction completes.
- Selection: the restored files with their contents and the absent paths that `skill-restoration` chooses for one compaction.
- Absent-file list: the paths in the inserted message that did not fit, with an instruction to read each of them before relevant work.
