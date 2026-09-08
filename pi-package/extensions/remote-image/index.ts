import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { readRemoteImageConfig } from "./environment.ts";
import { receiveImage } from "./receiver.ts";

const SHORTCUT = Key.ctrl("v");
const ISSUE_PREFIX = "[remote-image]";

export type RemoteImageConfig =
	| { readonly kind: "disabled" }
	| { readonly kind: "invalid"; readonly issue: string }
	| { readonly kind: "enabled"; readonly port: number };

export type ReceiveImageResult =
	| { readonly kind: "empty" }
	| { readonly kind: "saved"; readonly path: string };

export interface RemoteImageDependencies {
	readonly readConfig: () => RemoteImageConfig;
	readonly receiveImage: (port: number) => Promise<ReceiveImageResult>;
}

const DEFAULT_DEPENDENCIES: RemoteImageDependencies = {
	readConfig: readRemoteImageConfig,
	receiveImage,
};

export default function remoteImage(
	pi: ExtensionAPI,
	dependencies: RemoteImageDependencies = DEFAULT_DEPENDENCIES,
): void {
	const config = dependencies.readConfig();
	if (config.kind === "disabled") {
		return;
	}
	if (config.kind === "invalid") {
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.notify(
				`${ISSUE_PREFIX} ${config.issue}. Extension disabled.`,
				"error",
			);
		});
		return;
	}

	pi.registerShortcut(SHORTCUT, {
		description: "Paste an image from the local computer",
		handler: async (ctx) => {
			await pasteRemoteImage(ctx, config.port, dependencies.receiveImage);
		},
	});
}

async function pasteRemoteImage(
	ctx: ExtensionContext,
	port: number,
	receive: RemoteImageDependencies["receiveImage"],
): Promise<void> {
	try {
		const result = await receive(port);
		if (result.kind === "empty") {
			ctx.ui.notify(
				`${ISSUE_PREFIX} The local clipboard has no image.`,
				"warning",
			);
			return;
		}
		ctx.ui.pasteToEditor(result.path);
	} catch (error) {
		ctx.ui.notify(
			`${ISSUE_PREFIX} Failed to receive image: ${formatError(error)}`,
			"error",
		);
	}
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
