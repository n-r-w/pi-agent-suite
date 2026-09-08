import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReceiveImageResult } from "./index.ts";

const REQUEST_TIMEOUT_MS = 5_000;
const NO_CONTENT_STATUS = 204;
const IMAGE_CONTENT_TYPE = "image/png";
const TEMP_DIRECTORY_PREFIX = "pi-remote-image-";
const FILE_MODE = 0o600;

type ImageFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ReceiverDependencies {
	readonly fetch: ImageFetch;
	readonly makeTempDirectory: () => Promise<string>;
	readonly writeFile: (path: string, bytes: Uint8Array) => Promise<void>;
	readonly createId: () => string;
}

const DEFAULT_DEPENDENCIES: ReceiverDependencies = {
	fetch: (url, init) => fetch(url, init),
	makeTempDirectory: () => mkdtemp(join(tmpdir(), TEMP_DIRECTORY_PREFIX)),
	writeFile: async (path, bytes) => writeFile(path, bytes, { mode: FILE_MODE }),
	createId: randomUUID,
};

export async function receiveImage(
	port: number,
	dependencies: ReceiverDependencies = DEFAULT_DEPENDENCIES,
): Promise<ReceiveImageResult> {
	const response = await dependencies.fetch(
		`http://127.0.0.1:${port.toString()}/image`,
		{
			method: "GET",
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		},
	);
	if (response.status === NO_CONTENT_STATUS) {
		return { kind: "empty" };
	}
	if (!response.ok) {
		throw new Error(`Local helper returned HTTP ${response.status.toString()}`);
	}

	const contentType = response.headers.get("content-type")?.split(";", 1)[0];
	if (contentType !== IMAGE_CONTENT_TYPE) {
		throw new Error(
			`Local helper returned ${contentType ?? "no content type"} instead of ${IMAGE_CONTENT_TYPE}`,
		);
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.length === 0) {
		return { kind: "empty" };
	}

	const directory = await dependencies.makeTempDirectory();
	const path = join(directory, `${dependencies.createId()}.png`);
	await dependencies.writeFile(path, bytes);
	return { kind: "saved", path };
}
