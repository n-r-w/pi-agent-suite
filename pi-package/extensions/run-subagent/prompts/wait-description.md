Wait for first terminal feedback from selected active sessions until requested timeout.
Wait does not stop or change child execution.
If you need to wait for completion of a just-launched or steered subagent, then there is no point in setting a timeout of less than 30s, since subagent is unlikely to have time to do anything in less time.
