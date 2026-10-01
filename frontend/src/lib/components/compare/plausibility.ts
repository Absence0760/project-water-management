// The compare page's plausibility checks (RunComparison.plausibility, engine
// plausibility/compare.ts; docs/run-comparison.md § Plausibility checks): one
// row per check and site, each run's result in words and the change; then the
// recession diagnostics and the validation signatures, with notes on a side
// that has none (an older run, or nothing to score) or on two runs that
// scored different records. Pure, unit-tested.
import type {
	BfiDelta,
	FlowBreakLine,
	PlausibilityComparison,
	PlausibilityMetric,
	PlausibilityMissing,
	PlausibilitySiteDelta,
	RecessionDelta,
	SignaturesDelta
} from '@water-management/engine';
import { fmtNum, fmtPct } from '$lib/format/number';
import { scoredRecordText } from '$lib/components/runs/signatures';

/** 2001 → "2001/02". */
export const waterYear = (y: number) => `${y}/${String((y + 1) % 100).padStart(2, '0')}`;
const years = (ys: readonly number[], max = 6) =>
	ys.length > max ? `${ys.slice(0, max).map(waterYear).join(', ')} and ${ys.length - max} more` : ys.map(waterYear).join(', ');

const RECORD: Record<string, string> = { flow_observed_m3s: 'gauge', flow_logger_m3s: 'logger' };

export interface PlausibilityRow {
	/** Stable key: site + check. */
	key: string;
	/** The site ("Outlet", a gauge's name) or "Catchment" for checks 2 and 3. */
	site: string;
	check: string;
	a: string;
	b: string;
	/** Pass (true), fail (false) or not checked (null) on each side, for the row's marks. */
	okA: boolean | null;
	okB: boolean | null;
	change: string;
}

const HINT: Record<FlowBreakLine['hint'], string> = { newUse: 'new use', gauge: 'the gauge', unclear: 'unclear' };
const breakText = (b: FlowBreakLine) => `after ${waterYear(b.afterWaterYear)} (${b.change >= 0 ? '+' : '−'}${fmtNum(Math.abs(b.change) * 100, 0)} %, ${HINT[b.hint]})`;

function naturalisedRow(s: PlausibilitySiteDelta): PlausibilityRow | null {
	const n = s.naturalised;
	if (!n) return null;
	const side = (failed: number[] | null, judged: number | null, kind: string | null) => {
		if (failed === null) return 'not checked';
		const rec = kind ? ` (${RECORD[kind]})` : '';
		if (!judged) return `no water year judged${rec}`;
		return failed.length ? `fails ${years(failed)}: ${failed.length} of ${judged}${rec}` : `passes all ${judged}${rec}`;
	};
	const change = [
		n.newlyFailing.length ? `newly fails ${years(n.newlyFailing)}` : '',
		n.nowPassing.length ? `now passes ${years(n.nowPassing)}` : ''
	].filter(Boolean);
	return {
		key: `${s.nodeId ?? 'outlet'}|nat`,
		site: s.name,
		check: 'Natural ≥ observed + abstraction',
		a: side(n.failedA, n.judgedYears.a, n.flowKindA),
		b: side(n.failedB, n.judgedYears.b, n.flowKindB),
		okA: n.passedA,
		okB: n.passedB,
		change: n.failedA === null || n.failedB === null ? '–' : change.length ? change.join('; ') : 'same years'
	};
}

function lowFlowRow(s: PlausibilitySiteDelta): PlausibilityRow | null {
	const l = s.lowFlow;
	if (!l) return null;
	const side = (ratio: number | null, within: boolean | null) =>
		ratio === null ? 'not checked' : `${fmtNum(ratio, 2)}× (${within ? 'within' : 'outside'} the factor of 2)`;
	return {
		key: `${s.nodeId ?? 'outlet'}|q90`,
		site: s.name,
		check: 'Dry-season Q90, simulated ÷ observed',
		a: side(l.ratio.a, l.withinA),
		b: side(l.ratio.b, l.withinB),
		okA: l.withinA,
		okB: l.withinB,
		change: l.ratio.delta === null ? '–' : `${l.ratio.delta >= 0 ? '+' : '−'}${fmtNum(Math.abs(l.ratio.delta), 2)}×`
	};
}

/** "+0.07", "−0.07", "+0.00" (a value that rounds to zero is never "−0.00"). */
const signed = (v: number, digits: number) => `${v < 0 && Number(Math.abs(v).toFixed(digits)) !== 0 ? '−' : '+'}${fmtNum(Math.abs(v), digits)}`;

/** A value with a true minus sign, "−0.20" (fmtNum writes a hyphen). */
const minus = (v: number, digits: number) => (v < 0 && Number(Math.abs(v).toFixed(digits)) !== 0 ? '−' : '') + fmtNum(Math.abs(v), digits);

/** The engine that added each check, for the "made before" wording. */
const SINCE = { recession: '1.19.0', signatures: '1.55.0' } as const;

const missingText = (m: PlausibilityMissing, check: keyof typeof SINCE) =>
	m === 'older' ? `not in this run (made before engine ${SINCE[check]})` : check === 'recession' ? 'not checked (needs an observed record and rain)' : 'not computed (no observed record)';

function recessionRow(r: RecessionDelta): PlausibilityRow {
	const side = (missing: PlausibilityMissing | null, ratio: number | null, bDiff: number | null, obsFit: boolean | null, simFit: boolean | null, agrees: boolean | null, segments: number | null) => {
		if (missing) return missingText(missing, 'recession');
		const parts: string[] = [];
		if (ratio !== null) parts.push(`rate ${fmtNum(ratio, 2)}×`);
		if (bDiff !== null) parts.push(`b ${signed(bDiff, 2)}`);
		if (obsFit && simFit === false) parts.push('no simulated fit');
		if (obsFit === false) parts.push('no observed fit');
		const verdict =
			agrees === true
				? 'agrees'
				: agrees === false
					? 'disagrees'
					: segments !== null && segments < r.minSegments
						? `not judged: ${fmtNum(segments)} of ${r.minSegments} segments`
						: 'not judged';
		return parts.length ? `${parts.join(', ')} (${verdict})` : verdict;
	};
	const change = r.comparable
		? [r.rateRatio.delta !== null ? `rate ${signed(r.rateRatio.delta, 2)}×` : '', r.bDiff.delta !== null ? `b ${signed(r.bDiff.delta, 2)}` : ''].filter(Boolean).join('; ') || '–'
		: '–';
	return {
		key: 'outlet|recession',
		site: 'Outlet',
		check: 'Recessions, simulated vs observed (rate ratio, b difference)',
		a: side(r.missingA, r.rateRatio.a, r.bDiff.a, r.observedFitA, r.simulatedFitA, r.agreesA, r.segments.a),
		b: side(r.missingB, r.rateRatio.b, r.bDiff.b, r.observedFitB, r.simulatedFitB, r.agreesB, r.segments.b),
		okA: r.agreesA,
		okB: r.agreesB,
		change
	};
}

function signatureRowsOf(s: SignaturesDelta): PlausibilityRow[] {
	// One scored record in both: its site. Different records: the note above the table names each.
	const site = s.comparable || s.missingA ? (s.siteNameB ?? 'Outlet') : s.missingB ? (s.siteNameA ?? 'Outlet') : 'Scored record';
	const miss = (side: 'a' | 'b') => (side === 'a' ? s.missingA : s.missingB);
	/** That side computed the part (baseflow, the low-flow FDC, the held-out recessions). */
	const has = (x: 'a' | 'b', a: boolean | null, b: boolean | null) => (x === 'a' ? a : b) ?? false;
	const whole = (side: 'a' | 'b') => miss(side) && missingText(miss(side)!, 'signatures');
	const pick = (m: PlausibilityMetric, side: 'a' | 'b') => (side === 'a' ? m.a : m.b);

	const bfi = (label: string, key: string, d: BfiDelta): PlausibilityRow => {
		const side = (x: 'a' | 'b') => {
			const w = whole(x);
			if (w) return w;
			const o = pick(d.observed, x);
			const sim = pick(d.simulated, x);
			const diff = pick(d.difference, x);
			if (!has(x, s.baseflowA, s.baseflowB)) return 'not computed (under a year of record)';
			if (o === null || sim === null || diff === null) return 'not computed';
			const within = x === 'a' ? d.withinA : d.withinB;
			return `${fmtNum(o, 2)} observed, ${fmtNum(sim, 2)} simulated (${signed(diff, 2)}, ${within ? 'within' : 'outside'} ±${fmtNum(s.bfiLimit, 2)})`;
		};
		const parts: string[] = [];
		if (d.simulated.delta !== null) parts.push(`simulated ${signed(d.simulated.delta, 2)}`);
		if (d.observed.delta !== null && Number(Math.abs(d.observed.delta).toFixed(2)) !== 0) parts.push(`observed ${signed(d.observed.delta, 2)}`);
		return { key, site, check: label, a: side('a'), b: side('b'), okA: d.withinA, okB: d.withinB, change: parts.join('; ') || '–' };
	};

	const bias = (label: string, key: string, m: PlausibilityMetric, withinA: boolean | null, withinB: boolean | null): PlausibilityRow => {
		const side = (x: 'a' | 'b') => {
			const w = whole(x);
			if (w) return w;
			if (!has(x, s.lowFlowFdcA, s.lowFlowFdcB)) return 'not computed (under a year of record)';
			const v = pick(m, x);
			if (v === null) return 'not computed';
			return `${signed(v, 0)} % (${(x === 'a' ? withinA : withinB) ? 'within' : 'outside'} ±${s.lowFlowLimitPct} %)`;
		};
		return { key, site, check: label, a: side('a'), b: side('b'), okA: withinA, okB: withinB, change: m.delta === null ? '–' : `${signed(m.delta, 0)} points` };
	};

	const holdout = (x: 'a' | 'b') => {
		const w = whole(x);
		if (w) return w;
		if (!has(x, s.recessionHoldoutA, s.recessionHoldoutB)) return 'not computed (no catchment rain)';
		const skill = pick(s.holdoutModelSkill, x);
		const law = pick(s.holdoutLawSkill, x);
		const segs = pick(s.holdoutSegments, x);
		const agrees = x === 'a' ? s.holdoutAgreesA : s.holdoutAgreesB;
		if (skill === null) return 'not scored';
		const river = law !== null ? ` (the river’s own curve ${minus(law, 2)})` : '';
		const judged = agrees === null ? (segs !== null && segs < s.holdoutMinSegments ? `; not judged: ${fmtNum(segs)} of ${s.holdoutMinSegments} segments` : '; not judged') : '';
		return `${minus(skill, 2)}${river}${judged}`;
	};

	return [
		bfi('Base-flow index, Hughes et al. (2003)', 'sig|bfi-hughes', s.hughes),
		bfi('Base-flow index, Eckhardt (2005)', 'sig|bfi-eckhardt', s.eckhardt),
		bias('Low-flow FDC slope bias, Q70–Q95', 'sig|fdc-slope', s.slopeBiasPct, s.slopeWithinA, s.slopeWithinB),
		bias('Low-flow volume bias (%BiasFLV)', 'sig|flv', s.lowVolumeBiasPct, s.lowVolumeWithinA, s.lowVolumeWithinB),
		{
			key: 'sig|holdout',
			site,
			check: 'Skill on held-out recessions, simulated',
			a: holdout('a'),
			b: holdout('b'),
			okA: s.holdoutAgreesA,
			okB: s.holdoutAgreesB,
			change: s.holdoutModelSkill.delta === null ? '–' : signed(s.holdoutModelSkill.delta, 2)
		}
	];
}

/**
 * Notes above the table for the recession diagnostics and the validation
 * signatures: a run that has none (and why), and two runs whose numbers are
 * of different records, so no change is given.
 */
export function plausibilityNotes(c: PlausibilityComparison): string[] {
	const notes: string[] = [];
	const who = (side: 'A' | 'B') => `Run ${side}`;
	const missing = (name: string, since: string, a: PlausibilityMissing | null, b: PlausibilityMissing | null, none: string) => {
		if (a === 'older' && b === 'older') {
			notes.push(`Neither run has ${name}: both were made before engine ${since}.`);
			return;
		}
		for (const [side, m] of [['A', a], ['B', b]] as const) {
			if (m === 'older') notes.push(`${who(side)} was made before engine ${since}, so it has no ${name}: run the model again to compare them.`);
			else if (m === 'none') notes.push(`${who(side)} has no ${name}: ${none}`);
		}
	};
	const r = c.recession;
	if (r) {
		missing('recession diagnostics', SINCE.recession, r.missingA, r.missingB, 'they need an observed flow record and catchment rain.');
		if (!r.comparable && !r.missingA && !r.missingB) {
			const rec = (k: string | null) => `the ${k === 'flow_logger_m3s' ? 'logger' : 'gauge'} record`;
			notes.push(`The recession diagnostics are of different records (run A ${rec(r.flowKindA)}, run B ${rec(r.flowKindB)}), so no change is given.`);
		}
	}
	const s = c.signatures;
	if (s) {
		missing('validation signatures', SINCE.signatures, s.missingA, s.missingB, 'it has no observed flow record to score.');
		if (!s.comparable && !s.missingA && !s.missingB) {
			const rec = (k: SignaturesDelta['flowKindA'], name: string | null) => scoredRecordText({ flowKind: k ?? 'flow_observed_m3s', siteName: name ?? undefined });
			notes.push(
				`The validation signatures score different records (run A ${rec(s.flowKindA, s.siteNameA)}, run B ${rec(s.flowKindB, s.siteNameB)}), so no change is given.`
			);
		}
	}
	return notes;
}

/**
 * The table's rows: per site (outlet first) checks 1 and 4, then the
 * catchment-wide checks 2 and 3, the recession diagnostics and the
 * validation signatures.
 */
export function plausibilityRows(c: PlausibilityComparison): PlausibilityRow[] {
	const rows: PlausibilityRow[] = [];
	for (const s of c.sites) {
		for (const r of [naturalisedRow(s), lowFlowRow(s)]) if (r) rows.push({ ...r, site: s.nameA ? `${s.name} (was ${s.nameA})` : s.name });
	}
	const r = c.rainSource;
	if (r) {
		const side = (good: number | null, fallback: number | null, fy: number | null, warns: boolean | null) =>
			good === null && fallback === null
				? 'not checked'
				: !fy
					? `no fallback-rain year (${fmtPct(good, 0)} of days not met)`
					: `${fmtPct(fallback, 0)} of days not met in ${fy} fallback-rain year${fy === 1 ? '' : 's'}, ${fmtPct(good, 0)} in good-rain years${warns ? ' (warns)' : ''}`;
		rows.push({
			key: 'catchment|rain',
			site: 'Catchment',
			check: 'EWR days by rain source',
			a: side(r.goodFractionNotMet.a, r.fallbackFractionNotMet.a, r.fallbackYears.a, r.warnsA),
			b: side(r.goodFractionNotMet.b, r.fallbackFractionNotMet.b, r.fallbackYears.b, r.warnsB),
			okA: r.warnsA === null ? (r.fallbackYears.a === 0 ? true : null) : !r.warnsA,
			okB: r.warnsB === null ? (r.fallbackYears.b === 0 ? true : null) : !r.warnsB,
			change: r.fallbackYears.delta ? `${r.fallbackYears.delta > 0 ? '+' : '−'}${Math.abs(r.fallbackYears.delta)} fallback-rain years` : '–'
		});
	}
	const d = c.flowDoubleMass;
	if (d) {
		const side = (b: FlowBreakLine[] | null) => (b === null ? 'not checked' : b.length ? b.map(breakText).join('; ') : 'no break the model doesn’t share');
		rows.push({
			key: 'catchment|dm',
			site: 'Catchment',
			check: 'Observed flow vs rain (double mass)',
			a: side(d.breaksA),
			b: side(d.breaksB),
			okA: d.breaksA === null ? null : !d.breaksA.length,
			okB: d.breaksB === null ? null : !d.breaksB.length,
			change: d.wholeSlope.delta === null ? '–' : `runoff ratio ${d.wholeSlope.delta >= 0 ? '+' : '−'}${fmtNum(Math.abs(d.wholeSlope.delta), 3)}`
		});
	}
	// The recession diagnostics and the validation signatures, when a run has them (older engines' summaries may lack both keys).
	if (c.recession) rows.push(recessionRow(c.recession));
	if (c.signatures) rows.push(...signatureRowsOf(c.signatures));
	return rows;
}
