export interface ScrollMetrics {
	readonly offset: number;
	readonly total: number;
	readonly viewport: number;
}

export interface ScrollThumb {
	readonly start: number;
	readonly length: number;
}

/** Maps scroll metrics to a bounded thumb on an existing border track. */
export function calculateScrollThumb(
	metrics: ScrollMetrics,
	trackLength: number,
): ScrollThumb | undefined {
	const track = Math.max(0, Math.floor(trackLength));
	const total = Math.max(0, Math.floor(metrics.total));
	const viewport = Math.max(0, Math.floor(metrics.viewport));
	if (track === 0 || viewport === 0 || total <= viewport) {
		return undefined;
	}
	const length = Math.max(1, Math.floor((track * viewport) / total));
	const maximumOffset = total - viewport;
	const offset = Math.max(
		0,
		Math.min(Math.floor(metrics.offset), maximumOffset),
	);
	const start = Math.round(
		(offset / maximumOffset) * Math.max(0, track - length),
	);
	return { start, length };
}

/** Reports whether one track row belongs to the calculated thumb. */
export function isScrollThumbRow(
	thumb: ScrollThumb | undefined,
	row: number,
): boolean {
	return (
		thumb !== undefined &&
		row >= thumb.start &&
		row < thumb.start + thumb.length
	);
}
