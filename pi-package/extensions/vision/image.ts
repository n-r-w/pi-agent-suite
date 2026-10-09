import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { expandHomePath } from "../../shared/path-expansion";

const MAX_SOURCE_BYTES = 67_108_864;
const PNG_SIGNATURE = new Uint8Array(Buffer.from("89504e47", "hex"));
const JPEG_SIGNATURE = new Uint8Array(Buffer.from("ffd8ff", "hex"));
const GIF_SIGNATURES = ["GIF87a", "GIF89a"];
const GIF_SIGNATURE_LENGTH = 6;
const RIFF_SIGNATURE = "RIFF";
const WEBP_SIGNATURE = "WEBP";
const RIFF_SIGNATURE_LENGTH = 4;
const WEBP_OFFSET = 8;
const WEBP_END_OFFSET = 12;

export interface ImageCompressionConfig {
	readonly enabled: boolean;
	readonly jpegQuality: number;
	readonly maxBytes: number;
}

/** Encoded image and its media type for a model request. */
export interface LoadedImage {
	/** Base64-encoded image bytes. */
	readonly data: string;
	/** Media type of the encoded bytes. */
	readonly mimeType: string;
}

export class ImageLoadError extends Error {
	public constructor(
		public readonly code: string,
		message: string,
	) {
		super(message);
	}
}

type ResizeImage = typeof resizeImage;

/** Loads an image with the configured compression. */
export async function loadImage(
	input: string,
	options: {
		readonly cwd: string;
		readonly compression: ImageCompressionConfig;
	},
	dependencies: { readonly resizeImage?: ResizeImage } = {},
): Promise<LoadedImage> {
	const bytes = await readInput(input, options.cwd);
	if (bytes.byteLength > MAX_SOURCE_BYTES) {
		throw new ImageLoadError("too_large", "image source exceeds 64 MB");
	}
	const mimeType = detectMimeType(bytes);
	if (mimeType === undefined) {
		throw new ImageLoadError(
			"unsupported_format",
			"image format is unsupported",
		);
	}
	return compress(
		bytes,
		mimeType,
		options.compression,
		dependencies.resizeImage ?? resizeImage,
	);
}

/** Keeps compressed image bytes paired with their media type. */
async function compress(
	bytes: Uint8Array,
	mimeType: LoadedImage["mimeType"],
	compression: ImageCompressionConfig,
	resize: ResizeImage,
): Promise<LoadedImage> {
	if (!compression.enabled) {
		return { data: Buffer.from(bytes).toString("base64"), mimeType };
	}
	const resized = await resize(bytes, mimeType, {
		maxBytes: compression.maxBytes,
		jpegQuality: compression.jpegQuality,
		maxWidth: Number.MAX_SAFE_INTEGER,
		maxHeight: Number.MAX_SAFE_INTEGER,
	});
	return resized === null
		? { data: Buffer.from(bytes).toString("base64"), mimeType }
		: { data: resized.data, mimeType: resized.mimeType };
}

async function readInput(input: string, cwd: string): Promise<Uint8Array> {
	const expandedInput = expandHomePath(input);
	const path = isAbsolute(expandedInput)
		? expandedInput
		: resolve(cwd, expandedInput);
	try {
		const metadata = await stat(path);
		if (!metadata.isFile()) {
			throw new ImageLoadError("not_a_file", `${input} is not a file`);
		}
		return await readFile(path);
	} catch (error) {
		if (error instanceof ImageLoadError) {
			throw error;
		}
		const code =
			error instanceof Error && "code" in error ? error.code : undefined;
		if (code === "ENOENT") {
			throw new ImageLoadError("not_found", `${input} was not found`);
		}
		throw new ImageLoadError("read_error", `could not read ${input}`);
	}
}

function detectMimeType(
	bytes: Uint8Array,
): LoadedImage["mimeType"] | undefined {
	if (startsWith(bytes, PNG_SIGNATURE)) {
		return "image/png";
	}
	if (startsWith(bytes, JPEG_SIGNATURE)) {
		return "image/jpeg";
	}
	const prefix = String.fromCharCode(...bytes.slice(0, GIF_SIGNATURE_LENGTH));
	if (GIF_SIGNATURES.includes(prefix)) {
		return "image/gif";
	}
	if (
		String.fromCharCode(...bytes.slice(0, RIFF_SIGNATURE_LENGTH)) ===
			RIFF_SIGNATURE &&
		String.fromCharCode(...bytes.slice(WEBP_OFFSET, WEBP_END_OFFSET)) ===
			WEBP_SIGNATURE
	) {
		return "image/webp";
	}
	return undefined;
}

function startsWith(bytes: Uint8Array, signature: Uint8Array): boolean {
	return signature.every((value, index) => bytes[index] === value);
}
