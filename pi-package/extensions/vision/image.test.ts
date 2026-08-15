import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadImage } from "./image";

const PNG = "iVBORw0KGgo=";

describe("loadImage", () => {
	test("loads an existing image file", async () => {
		const directory = await mkdtemp(join(tmpdir(), "vision-image-"));
		await writeFile(join(directory, "test.png"), Buffer.from(PNG, "base64"));
		expect(
			await loadImage("test.png", {
				cwd: directory,
				compression: { enabled: false, jpegQuality: 85, maxBytes: 4_718_592 },
			}),
		).toEqual({ data: PNG, mimeType: "image/png" });
	});

	test("uses the injected resizer when compression is enabled", async () => {
		const directory = await mkdtemp(join(tmpdir(), "vision-image-"));
		await writeFile(join(directory, "test.png"), Buffer.from(PNG, "base64"));
		let calls = 0;
		const resizedData = "R0lGODlh";
		const image = await loadImage(
			"test.png",
			{
				cwd: directory,
				compression: { enabled: true, jpegQuality: 85, maxBytes: 4_718_592 },
			},
			{
				resizeImage: async () => {
					calls += 1;
					return {
						data: resizedData,
						mimeType: "image/gif",
						originalWidth: 1,
						originalHeight: 1,
						width: 1,
						height: 1,
						wasResized: true,
					};
				},
			},
		);
		expect(calls).toBe(1);
		expect(image).toEqual({ data: resizedData, mimeType: "image/png" });
	});

	test("reports file and input loading errors", async () => {
		const directory = await mkdtemp(join(tmpdir(), "vision-image-"));
		await mkdir(join(directory, "folder"));
		const largeFile = await open(join(directory, "large.png"), "w");
		await largeFile.truncate(67_108_865);
		await largeFile.close();
		const options = {
			cwd: directory,
			compression: { enabled: false, jpegQuality: 85, maxBytes: 4_718_592 },
		};
		await expect(loadImage("missing.png", options)).rejects.toMatchObject({
			code: "not_found",
		});
		await expect(loadImage("folder", options)).rejects.toMatchObject({
			code: "not_a_file",
		});
		await expect(loadImage("large.png", options)).rejects.toMatchObject({
			code: "too_large",
		});
		await expect(loadImage("\u0000", options)).rejects.toMatchObject({
			code: "read_error",
		});
	});

	test("rejects an unsupported image format", async () => {
		const directory = await mkdtemp(join(tmpdir(), "vision-image-"));
		await writeFile(join(directory, "plain.txt"), Buffer.from("plain text"));
		await expect(
			loadImage("plain.txt", {
				cwd: directory,
				compression: { enabled: false, jpegQuality: 85, maxBytes: 4_718_592 },
			}),
		).rejects.toMatchObject({ code: "unsupported_format" });
	});
});
