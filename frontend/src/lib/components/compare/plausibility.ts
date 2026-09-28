// The compare page's plausibility checks (RunComparison.plausibility, engine
// plausibility/compare.ts; docs/run-comparison.md § Plausibility checks): one
// row per check and site, each run's result in words and the change. Pure,
// unit-tested.
import type { FlowBreakLine, PlausibilityComparison, PlausibilitySiteDelta } from '@water-management/engine';
import { fmtNum, fmtPct } from '$lib/format/number';

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

/** The table's rows: per site (outlet first) checks 1 and 4, then the catchment-wide checks 2 and 3. */
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
	return rows;
}
