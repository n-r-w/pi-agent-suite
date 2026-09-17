import { describe, expect, test } from "bun:test";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTempDir } from "../../../test/support/temp-dir.ts";
import { MCP_STDIO_LOG_MAX_BYTES, McpStdioLogWriter } from "./stdio-log.ts";

const INITIALIZING_RECORD =
	/^\[[^\]]+\] \[server one\] \[initializing\] diagnostic line\n$/;
const ROTATED_RECORD =
	/^\[[^\]]+\] \[files\] \[initializing\] after rotation\n$/;

describe("mcp-wrapper stdio log", () => {
	test("appends server diagnostics and retries one failed write", async () => {
		// Purpose: transient file-open or append failures must not discard the diagnostic immediately.
		// Inputs and expected outputs: one Buffer chunk, one failed append, then one successful prefixed log record.
		// Edge case: the first write attempt fails before the log file exists.
		// Dependencies: an isolated temporary directory and an injected append operation.
		const temp = createTempDir("pi-mcp-stderr-log-");
		const logPath = join(temp.path, "stdio.log");
		let attempts = 0;
		try {
			const writer = new McpStdioLogWriter("server one", {
				logPath,
				appendFile: async (path, data, options) => {
					attempts += 1;
					if (attempts === 1) {
						throw new Error("temporary append failure");
					}
					await appendFile(path, data, options);
				},
			});

			writer.write(Buffer.from("diagnostic line\n"));
			await writer.flush();

			const content = await readFile(logPath, "utf8");
			expect(attempts).toBe(2);
			expect(content).toMatch(INITIALIZING_RECORD);
		} finally {
			temp.remove();
		}
	});

	test("keeps one bounded archive when the active log exceeds the limit", async () => {
		// Purpose: repeated local diagnostics must not grow one active log without a size boundary.
		// Inputs and expected outputs: an oversized active file becomes .1 and the next chunk starts a new active file.
		// Edge case: an existing archive is replaced during rotation.
		// Dependencies: isolated temporary files and the production writer.
		const temp = createTempDir("pi-mcp-stderr-rotate-");
		const logPath = join(temp.path, "stdio.log");
		try {
			await writeFile(`${logPath}.1`, "old archive");
			await writeFile(logPath, "x".repeat(MCP_STDIO_LOG_MAX_BYTES + 1));
			const writer = new McpStdioLogWriter("files", { logPath });

			writer.write("after rotation\n");
			await writer.flush();

			expect((await readFile(`${logPath}.1`, "utf8")).length).toBe(
				MCP_STDIO_LOG_MAX_BYTES + 1,
			);
			expect(await readFile(logPath, "utf8")).toMatch(ROTATED_RECORD);
		} finally {
			temp.remove();
		}
	});
});
