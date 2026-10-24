// Golden fingerprints of a run that hold across platforms (issue #553). The
// same code gives last-bit different floats on macOS arm64 and on CI's Linux
// x64 (libm), so an exact hash over every value's bits passes on one and
// fails on the other. These keep the exact parts exact (which series exist,
// their lengths, the summary's text and strings) and compare the numbers by
// moments at a relative tolerance: platform noise is ~1e-13, while a real
// change of one day's rain moves a series' moments by ~1e-7 or more.
import type { ModelOutput } from '../project';
import { Hasher } from '../warmstart/plain';

/** Sum, sum of squares and a position-weighted sum (catches values that only move between days). */
export interface Moments {
	sum: number;
	sumSq: number;
	weighted: number;
}

export interface GoldenFingerprint {
	/** Exact: every series' node, key and length, and the summary as JSON with its numbers blanked. */
	shape: string;
	/** Per series of `keys` (`<key>@<node>`): its moments. */
	series: Record<string, Moments>;
	/** Every other output series' values together, and every number of the summary, in order. */
	rest: Moments;
	summary: Moments;
}

const weight = (s: number, i: number) => 1 + ((i * 7919 + s * 104_729) % 1009) / 1009;

function add(m: Moments, v: number, w: number) {
	m.sum += v;
	m.sumSq += v * v;
	m.weighted += v * w;
}

const zero = (): Moments => ({ sum: 0, sumSq: 0, weighted: 0 });

/** The fingerprint of a run; `keys` names the series pinned one by one (the rest are pinned together). */
export function goldenFingerprint(out: Pick<ModelOutput, 'series' | 'summary'>, keys: RegExp, summary: unknown = out.summary): GoldenFingerprint {
	const shape = new Hasher();
	const series: Record<string, Moments> = {};
	const rest = zero();
	out.series.forEach((s, si) => {
		shape.text(s.nodeId ?? '').text(s.key).number(s.values.length);
		const own = keys.test(s.key) ? (series[`${s.key}@${s.nodeId ?? ''}`] = zero()) : null;
		s.values.forEach((v, i) => add(own ?? rest, v, weight(si, i)));
	});
	const sum = zero();
	let n = 0;
	const text = JSON.stringify(summary, (_k, v) => {
		if (typeof v !== 'number') return v;
		add(sum, v, weight(0, n++));
		return 0;
	});
	shape.text(text ?? '');
	return { shape: shape.digest(), series, rest, summary: sum };
}

const close = (a: number, b: number, rel: number) => a === b || Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b));

/** Where `got` differs from `want` past `rel` (relative), as readable lines; empty when they agree. */
export function goldenDiff(got: GoldenFingerprint, want: GoldenFingerprint, rel = 1e-9): string[] {
	const out: string[] = [];
	if (got.shape !== want.shape) out.push(`shape ${got.shape} ≠ ${want.shape} (a series appeared, vanished or changed length, or the summary's text changed)`);
	const moments = (name: string, g: Moments | undefined, w: Moments | undefined) => {
		if (!g || !w) return void out.push(`${name}: ${g ? 'not expected' : 'missing'}`);
		for (const k of ['sum', 'sumSq', 'weighted'] as const) if (!close(g[k], w[k], rel)) out.push(`${name}.${k} ${g[k]} ≠ ${w[k]}`);
	};
	for (const k of new Set([...Object.keys(got.series), ...Object.keys(want.series)])) moments(k, got.series[k], want.series[k]);
	moments('rest', got.rest, want.rest);
	moments('summary', got.summary, want.summary);
	return out;
}
