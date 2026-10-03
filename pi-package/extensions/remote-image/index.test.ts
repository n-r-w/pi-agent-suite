import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import remoteImage, { type RemoteImageDependencies } from "./index.ts";

type ShortcutHandler = (ctx: ExtensionContextFake) => void | Promise<void>;

interface ExtensionContextFake {
	readonly ui: {
		notify(message: string, level: string): void;
		pasteToEditor(text: string): void;
		setStatus(key: string, text: string | undefined): void;
	};
}

interface ExtensionApiFake {
	readonly shortcuts: Array<{
		readonly shortcut: string;
		readonly handler: ShortcutHandler;
	}>;
	registerShortcut(
		shortcut: string,
		options: { readonly handler: ShortcutHandler },
	): void;
}

function createApi(): ExtensionApiFake {
	const shortcuts: ExtensionApiFake["shortcuts"] = [];
	return {
		shortcuts,
		registerShortcut(shortcut, options): void {
			shortcuts.push({ shortcut, handler: options.handler });
		},
	};
}

function createContext(): {
	readonly context: ExtensionContextFake;
	readonly notifications: Array<{
		readonly message: string;
		readonly level: string;
	}>;
	readonly pasted: string[];
	readonly readRenderedEditorText: () => string;
	readonly statuses: ReadonlyMap<string, string>;
} {
	const notifications: Array<{
		message: string;
		level: string;
	}> = [];
	const pasted: string[] = [];
	let renderedEditorText = "";
	const statuses = new Map([["another-extension", "Existing status"]]);
	return {
		context: {
			ui: {
				notify(message, level): void {
					notifications.push({ message, level });
				},
				pasteToEditor(text): void {
					pasted.push(text);
				},
				setStatus(key, text): void {
					if (text === undefined) {
						statuses.delete(key);
					} else {
						statuses.set(key, text);
					}
					renderedEditorText = pasted.join("");
				},
			},
		},
		notifications,
		pasted,
		readRenderedEditorText: () => renderedEditorText,
		statuses,
	};
}

describe("remote-image", () => {
	test("registers Ctrl+V only in remote mode", () => {
		// Purpose: local sessions must keep pi's native clipboard behavior.
		// Input and expected output: remote mode registers ctrl+v; local mode registers nothing.
		// Edge case: an unset mode is treated as local mode.
		// Dependencies: this test uses an in-memory ExtensionAPI fake.
		const remoteApi = createApi();
		const localApi = createApi();

		remoteImage(remoteApi as unknown as ExtensionAPI, {
			readConfig: () => ({ kind: "enabled", port: 18775 }),
			receiveImage: async () => ({ kind: "empty" }),
		});
		remoteImage(localApi as unknown as ExtensionAPI, {
			readConfig: () => ({ kind: "disabled" }),
			receiveImage: async () => ({ kind: "empty" }),
		});

		expect(remoteApi.shortcuts.map(({ shortcut }) => shortcut)).toEqual([
			"ctrl+v",
		]);
		expect(localApi.shortcuts).toHaveLength(0);
	});

	test("renders a saved server path without another key press", async () => {
		const api = createApi();
		const { context, notifications, pasted, readRenderedEditorText, statuses } =
			createContext();
		const dependencies: RemoteImageDependencies = {
			readConfig: () => ({ kind: "enabled", port: 18775 }),
			receiveImage: async () => ({
				kind: "saved",
				path: "/tmp/pi-remote-image/example.png",
			}),
		};
		remoteImage(api as unknown as ExtensionAPI, dependencies);

		await api.shortcuts[0]?.handler(context);

		expect(pasted).toEqual(["/tmp/pi-remote-image/example.png"]);
		expect(readRenderedEditorText()).toBe("/tmp/pi-remote-image/example.png");
		expect([...statuses]).toEqual([["another-extension", "Existing status"]]);
		expect(notifications).toEqual([]);
	});

	test("reports an empty clipboard without inserting a path", async () => {
		// Purpose: the user must get feedback when the local clipboard has no image.
		// Input and expected output: an empty result emits one warning and inserts nothing.
		// Edge case: the editor remains unchanged.
		// Dependencies: the transfer is isolated behind a deterministic fake.
		const api = createApi();
		const { context, notifications, pasted } = createContext();
		remoteImage(api as unknown as ExtensionAPI, {
			readConfig: () => ({ kind: "enabled", port: 18775 }),
			receiveImage: async () => ({ kind: "empty" }),
		});

		await api.shortcuts[0]?.handler(context);

		expect(pasted).toEqual([]);
		expect(notifications).toEqual([
			{
				message: "[remote-image] The local clipboard has no image.",
				level: "warning",
			},
		]);
	});

	test("reports transfer failures without inserting a path", async () => {
		// Purpose: tunnel and file errors must not produce invalid editor paths.
		// Input and expected output: a rejected transfer emits one error and inserts nothing.
		// Edge case: the editor remains unchanged after a rejected transfer.
		// Dependencies: the transfer is isolated behind a rejecting fake.
		const api = createApi();
		const { context, notifications, pasted } = createContext();
		remoteImage(api as unknown as ExtensionAPI, {
			readConfig: () => ({ kind: "enabled", port: 18775 }),
			receiveImage: async () => {
				throw new Error("tunnel unavailable");
			},
		});

		await api.shortcuts[0]?.handler(context);

		expect(pasted).toEqual([]);
		expect(notifications).toEqual([
			{
				message: "[remote-image] Failed to receive image: tunnel unavailable",
				level: "error",
			},
		]);
	});
});
