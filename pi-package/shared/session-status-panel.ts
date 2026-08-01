import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";

/** Stores the controller on Pi's shared event carrier across extension modules. */
const PANEL_PROPERTY = "__piHarnessSessionStatusPanel";

/** Identifies the single widget owned by the shared session-status panel. */
const PANEL_WIDGET_KEY = "session-status-panel";

/** Produces one themed single-line status value for the shared session panel. */
export type SessionStatusRowRenderer = (theme: Theme) => string;

/** Identifies and orders one independently owned session-status row. */
export interface SessionStatusRowRegistration {
	/** Keeps producer updates isolated from other rows. */
	readonly key: string;
	/** Defines stable ascending row order without coupling the panel to producers. */
	readonly order: number;
}

/** Controls one producer row without exposing the shared widget owner. */
export interface SessionStatusRowHandle {
	/** Replaces or hides the producer's current rendered row. */
	set(renderer: SessionStatusRowRenderer | undefined): void;
	/** Releases the producer row without affecting newer owners or other rows. */
	dispose(): void;
}

/** Tracks one live producer handle and its optional visible row. */
interface SessionStatusRowState extends SessionStatusRowRegistration {
	/** Prevents a replaced handle from changing its newer replacement. */
	readonly owner: symbol;
	/** Supplies the visible row or keeps the registered slot hidden. */
	renderer: SessionStatusRowRenderer | undefined;
}

/** Holds a controller generation until its final producer releases ownership. */
interface SessionStatusPanelHolder {
	/** Composes every producer row into the shared widget. */
	controller: SessionStatusPanelController | undefined;
	/** Forces a fresh controller after the previous generation becomes idle. */
	stale: boolean;
}

/** Adds the private status-panel holder to Pi's shared event carrier. */
interface SessionStatusPanelCarrier {
	[PANEL_PROPERTY]?: SessionStatusPanelHolder;
}

/** Renders one separator followed by every current status row. */
class SessionStatusPanelComponent implements Component {
	public constructor(
		private readonly rows: readonly SessionStatusRowRenderer[],
		private readonly theme: Theme,
	) {}

	/** Bounds the separator and each independently rendered row to the viewport. */
	public render(width: number): string[] {
		if (width <= 0) {
			return [];
		}
		return [
			"─".repeat(width),
			...this.rows.map((row) => truncateToWidth(row(this.theme), width, "…")),
		];
	}

	/** Invalidates no cache because rendering always uses current immutable rows. */
	public invalidate(): void {}
}

/** Owns the one Pi widget shared by independent status producers. */
class SessionStatusPanelController {
	/** Keeps registered producers ordered and independently replaceable by key. */
	private readonly rows = new Map<string, SessionStatusRowState>();

	/** Uses the most recently attached session UI for widget publication. */
	private ui: ExtensionContext["ui"] | undefined;

	public constructor(private readonly onIdle: () => void) {}

	/** Acquires one keyed row and returns an idempotent producer handle. */
	public acquire(
		ui: ExtensionContext["ui"],
		registration: SessionStatusRowRegistration,
	): SessionStatusRowHandle {
		this.ui = ui;
		const owner = Symbol(registration.key);
		this.rows.set(registration.key, {
			...registration,
			owner,
			renderer: undefined,
		});
		this.publish();
		let disposed = false;
		return {
			set: (renderer) => {
				if (disposed) {
					return;
				}
				const current = this.rows.get(registration.key);
				if (current?.owner !== owner) {
					return;
				}
				current.renderer = renderer;
				this.publish();
			},
			dispose: () => {
				if (disposed) {
					return;
				}
				disposed = true;
				const current = this.rows.get(registration.key);
				if (current?.owner !== owner) {
					return;
				}
				this.rows.delete(registration.key);
				this.publish();
				if (this.rows.size === 0) {
					this.onIdle();
				}
			},
		};
	}

	/** Publishes the ordered visible rows or clears the widget when none remain. */
	private publish(): void {
		if (this.ui === undefined) {
			return;
		}
		const visibleRows = [...this.rows.values()]
			.filter(
				(
					row,
				): row is SessionStatusRowState & {
					readonly renderer: SessionStatusRowRenderer;
				} => row.renderer !== undefined,
			)
			.sort(
				(left, right) =>
					left.order - right.order || left.key.localeCompare(right.key),
			);
		if (visibleRows.length === 0) {
			this.ui.setWidget(PANEL_WIDGET_KEY, undefined);
			return;
		}
		const renderers = visibleRows.map(({ renderer }) => renderer);
		this.ui.setWidget(
			PANEL_WIDGET_KEY,
			(_tui, theme) => new SessionStatusPanelComponent(renderers, theme),
		);
	}
}

/** Returns the current controller or creates one for a new runtime generation. */
function getSessionStatusPanelController(
	pi: ExtensionAPI,
): SessionStatusPanelController {
	const carrier = pi.events as SessionStatusPanelCarrier;
	const existing = carrier[PANEL_PROPERTY];
	if (existing?.controller !== undefined && !existing.stale) {
		return existing.controller;
	}

	const holder: SessionStatusPanelHolder = {
		controller: undefined,
		stale: false,
	};
	holder.controller = new SessionStatusPanelController(() => {
		holder.stale = true;
	});
	if (existing !== undefined) {
		carrier[PANEL_PROPERTY] = holder;
		return holder.controller;
	}
	Object.defineProperty(carrier, PANEL_PROPERTY, {
		configurable: false,
		enumerable: false,
		value: holder,
		writable: true,
	});
	return holder.controller;
}

/** Acquires one producer row in the shared session-status panel. */
export function acquireSessionStatusRow(
	pi: ExtensionAPI,
	ui: ExtensionContext["ui"],
	registration: SessionStatusRowRegistration,
): SessionStatusRowHandle {
	return getSessionStatusPanelController(pi).acquire(ui, registration);
}
