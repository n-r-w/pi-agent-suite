import { describe, expect, test } from "bun:test";
import { type ReceiverDependencies, receiveImage } from "./receiver.ts";

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);

function response(
	status: number,
	bytes: Uint8Array,
	contentType = "image/png",
): Response {
	return new Response(Uint8Array.from(bytes).buffer, {
		status,
		headers: { "content-type": contentType },
	});
}

describe("receiveImage", () => {
	test("requests PNG bytes and saves them before returning the path", async () => {
		// Purpose: prove the request-to-file contract used by the editor shortcut.
		// Input and expected output: a PNG response is written to a new temp directory and its path is returned.
		// Edge case: the transfer uses only the configured loopback port.
		// Dependencies: HTTP and filesystem operations use isolated fakes.
		const events: string[] = [];
		const dependencies: ReceiverDependencies = {
			fetch: async (url) => {
				events.push(`fetch:${url}`);
				return response(200, PNG_BYTES);
			},
			makeTempDirectory: async () => "/tmp/pi-remote-image-test",
			writeFile: async (path, bytes) => {
				events.push(`write:${path}:${Array.from(bytes).join(",")}`);
			},
			createId: () => "image-id",
		};

		const result = await receiveImage(18775, dependencies);

		expect(result).toEqual({
			kind: "saved",
			path: "/tmp/pi-remote-image-test/image-id.png",
		});
		expect(events).toEqual([
			"fetch:http://127.0.0.1:18775/image",
			`write:/tmp/pi-remote-image-test/image-id.png:${Array.from(PNG_BYTES).join(",")}`,
		]);
	});

	test("returns empty for a no-content response", async () => {
		// Purpose: map an empty local clipboard to a non-error result.
		// Input and expected output: HTTP 204 returns the empty result and creates no file.
		// Edge case: the response has no body.
		// Dependencies: HTTP and filesystem operations use isolated fakes.
		let wroteFile = false;
		const result = await receiveImage(18775, {
			fetch: async () => response(204, new Uint8Array()),
			makeTempDirectory: async () => "/tmp/unused",
			writeFile: async () => {
				wroteFile = true;
			},
			createId: () => "unused",
		});

		expect(result).toEqual({ kind: "empty" });
		expect(wroteFile).toBe(false);
	});

	test("rejects non-PNG and unsuccessful responses", async () => {
		// Purpose: remote pi must never insert a path for an invalid helper response.
		// Input and expected output: an HTTP error and wrong content type each reject.
		// Edge case: a successful status with unexpected content is still invalid.
		// Dependencies: HTTP and filesystem operations use isolated fakes.
		const baseDependencies = {
			makeTempDirectory: async () => "/tmp/unused",
			writeFile: async () => {},
			createId: () => "unused",
		};

		await expect(
			receiveImage(18775, {
				...baseDependencies,
				fetch: async () => response(503, new Uint8Array()),
			}),
		).rejects.toThrow("Local helper returned HTTP 503");
		await expect(
			receiveImage(18775, {
				...baseDependencies,
				fetch: async () => response(200, PNG_BYTES, "text/plain"),
			}),
		).rejects.toThrow("Local helper returned text/plain instead of image/png");
	});
});
