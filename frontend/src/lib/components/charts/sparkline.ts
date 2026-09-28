// The sparkline's geometry and words (Sparkline.svelte), pure so they are
// unit-tested. A sparkline is the compact chart for a row or a card, where
// full axes don't fit; it still says what it shows (docs/design/ui-playbook.md
// § 3, "Label every chart"): a caption naming the quantity and its span, the
// first and last x labels under it, the peak (or low) marked with its value,
// a read-out of the point under the pointer, and an accessible name that
// carries the numbers.

/** The drawing box (stretched to the element; strokes don't scale). */
export const SPARK_W = 200;
export const SPARK_H = 40;
/** Room kept above and below the line inside the box, so a peak's stroke isn't clipped. */
const PAD = 2;

export interface SparkPoint {
	/** Index into the values. */
	i: number;
	/** 0 (left) … 1 (right). */
	x: number;
	/** 0 (top, `hi`) … 1 (bottom, `lo`). */
	y: number;
}

const finite = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

/**
 * One point per finite value, x evenly spaced (or `x[i]`, 0…1) and y from
 * `lo` (bottom) to `hi` (top), clamped to the box. Gaps are skipped.
 */
export function sparkPoints(values: readonly (number | null)[], lo: number, hi: number, x?: readonly number[]): SparkPoint[] {
	const n = values.length;
	const span = hi > lo ? hi - lo : 1;
	const pts: SparkPoint[] = [];
	values.forEach((v, i) => {
		if (!finite(v)) return;
		const fx = x?.[i] ?? (n > 1 ? i / (n - 1) : 0);
		const fy = 1 - Math.min(1, Math.max(0, (v - lo) / span));
		pts.push({ i, x: fx, y: fy });
	});
	return pts;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** The line's points and the shaded area under it, in the SPARK_W × SPARK_H box. */
export function sparkPaths(pts: readonly SparkPoint[]): { line: string; fill: string } {
	if (pts.length === 0) return { line: '', fill: '' };
	const xy = pts.map((p) => `${r1(p.x * SPARK_W)},${r1(PAD + p.y * (SPARK_H - 2 * PAD))}`);
	return {
		line: xy.join(' '),
		fill: `M${r1(pts[0]!.x * SPARK_W)},${SPARK_H} L${xy.join(' L')} L${r1(pts[pts.length - 1]!.x * SPARK_W)},${SPARK_H} Z`
	};
}

/** Where a point sits on the element, as fractions (for the HTML dot, which a stretched SVG would squash). */
export function dotAt(p: SparkPoint): { left: number; top: number } {
	return { left: p.x, top: (PAD + p.y * (SPARK_H - 2 * PAD)) / SPARK_H };
}

/** The first index of the highest (or lowest) finite value; -1 with none. */
export function extremeIndex(values: readonly (number | null)[], kind: 'max' | 'min'): number {
	let best = -1;
	values.forEach((v, i) => {
		if (!finite(v)) return;
		if (best < 0 || (kind === 'max' ? v > values[best]! : v < values[best]!)) best = i;
	});
	return best;
}

/** The point nearest to `fx` (0…1 across the element). */
export function nearestPoint(pts: readonly SparkPoint[], fx: number): SparkPoint | null {
	let best: SparkPoint | null = null;
	for (const p of pts) if (!best || Math.abs(p.x - fx) < Math.abs(best.x - fx)) best = p;
	return best;
}

export interface SparkWords {
	values: readonly (number | null)[];
	/** One per value: its month or date. */
	labels: readonly string[];
	format: (v: number) => string;
	mark: 'max' | 'min';
	/** "max", "peak", "low" … */
	markWord: string;
}

/** The marked point's words: "max 0.80" (with `withLabel`, "low 15% · 19 Dec 2023"); '' with no values. */
export function markText({ values, labels, format, mark, markWord }: SparkWords, withLabel: boolean): string {
	const i = extremeIndex(values, mark);
	if (i < 0) return '';
	return `${markWord} ${format(values[i]!)}${withLabel && labels[i] ? ` · ${labels[i]}` : ''}`;
}

/** The read-out for one point: "Jan 0.80". */
export function readout(labels: readonly string[], values: readonly (number | null)[], i: number, format: (v: number) => string): string {
	const v = values[i];
	return `${labels[i] ?? ''} ${finite(v) ? format(v) : 'no value'}`.trim();
}

/**
 * The numbers in words, for the accessible name: every value when there are
 * a dozen or fewer ("Oct 0.60, Nov 0.70, …"), else the ends, the marked
 * point and the other extreme.
 */
export function sparkDescription(w: SparkWords, ends: readonly [string, string]): string {
	const { values, labels, format, mark } = w;
	const i = extremeIndex(values, mark);
	if (i < 0) return 'no values';
	const lead = `${markText(w, false)} in ${labels[i] ?? ''}`.replace(/ in $/, '');
	if (values.length <= 12) {
		return `${lead}; ${values.map((v, k) => readout(labels, values, k, format)).join(', ')}`;
	}
	const first = values.findIndex(finite);
	let last = values.length - 1;
	while (last > 0 && !finite(values[last])) last--;
	const other = extremeIndex(values, mark === 'max' ? 'min' : 'max');
	const otherWord = mark === 'max' ? 'low' : 'high';
	return (
		`${ends[0]} to ${ends[1]}: ${format(values[first]!)} at the start, ${format(values[last]!)} at the end; ` +
		`${markText(w, false)} on ${labels[i] ?? ''}, ${otherWord} ${format(values[other]!)} on ${labels[other] ?? ''}`
	);
}

/**
 * The keyboard's read-out (a slider over the points): the point a key moves
 * to from `at` (its index into `pts`). Right or Up is the next point, Left or
 * Down the one before, Page Up and Page Down a tenth of the line (a month of a
 * year's days), Home and End the ends; it stops at the ends. `undefined` for a
 * key it doesn't handle, so the key keeps its usual job (Tab).
 */
export function keyStep(pts: readonly SparkPoint[], at: number, key: string): number | undefined {
	if (pts.length === 0) return undefined;
	const page = Math.max(1, Math.round(pts.length / 10));
	const to =
		key === 'ArrowRight' || key === 'ArrowUp' ? at + 1
		: key === 'ArrowLeft' || key === 'ArrowDown' ? at - 1
		: key === 'PageUp' ? at + page
		: key === 'PageDown' ? at - page
		: key === 'Home' ? 0
		: key === 'End' ? pts.length - 1
		: undefined;
	return to === undefined ? undefined : Math.min(pts.length - 1, Math.max(0, to));
}
