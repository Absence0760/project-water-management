// Input data-quality checks that don't depend on a model run's results.
//
// observedAgreement: when a catchment has two observed flow records (the
// G1-style gauge and an A1-style logger), compare their volumes per water
// year on the days both have a reading. Two instruments on the same river
// should agree roughly; a year where one reads a small fraction of the other
// usually means something physical at one of them (weir damage, siltation, a
// rating change, bypass, zero-filled gaps) — and calibrating to the wrong one
// skews every result. Client Catchment: the gauge reads 8–33 % of the logger from
// 2014/15 (docs/plan.md, first hydrologist question).
import { toEpochDay } from './calendar';
import { waterYearOf } from './network/stats';
import type { DailySeries, SeriesKind } from './project';

/** Observed-flow kinds compared with each other (Pitman is modelled, not observed). */
export const OBSERVED_FLOW_KINDS = ['flow_observed_m3s', 'flow_logger_m3s'] as const satisfies readonly SeriesKind[];
export type ObservedFlowKind = (typeof OBSERVED_FLOW_KINDS)[number];

export const OBSERVED_FLOW_LABEL: Record<ObservedFlowKind, string> = {
	flow_observed_m3s: 'observed gauge flow',
	flow_logger_m3s: 'logger flow'
};

export interface AgreementOptions {
	/** Flag a year when a / b falls below this … (default 2/3). */
	minRatio?: number;
	/** … or above this (default 1.5). */
	maxRatio?: number;
	/** Ignore water years with fewer shared days than this (default 90). */
	minDays?: number;
}

export interface AgreementYear {
	/** Water year starting 1 October of this calendar year. */
	waterYear: number;
	/** Days where both records have a reading. */
	days: number;
	/** Volume on those days, million m³. */
	volumeAMm3: number;
	volumeBMm3: number;
	/** volumeA / volumeB; null when B recorded no volume. */
	ratio: number | null;
	flagged: boolean;
}

export interface ObservedAgreement {
	a: ObservedFlowKind;
	b: ObservedFlowKind;
	minRatio: number;
	maxRatio: number;
	minDays: number;
	years: AgreementYear[];
	/** Water years that were flagged, in order. */
	flaggedYears: number[];
}

const M3S_TO_MM3_PER_DAY = 86_400 / 1e6;

/**
 * Compare two daily m³/s series per water year on their shared days. Returns
 * null when either series is missing or they never overlap.
 */
export function observedAgreement(
	series: Partial<Record<SeriesKind, DailySeries>>,
	options: AgreementOptions = {}
): ObservedAgreement | null {
	const [a, b] = OBSERVED_FLOW_KINDS;
	const sa = series[a];
	const sb = series[b];
	if (!sa || !sb) return null;
	const minRatio = options.minRatio ?? 2 / 3;
	const maxRatio = options.maxRatio ?? 1.5;
	const minDays = options.minDays ?? 90;

	const a0 = toEpochDay(sa.startDate);
	const b0 = toEpochDay(sb.startDate);
	const from = Math.max(a0, b0);
	const to = Math.min(a0 + sa.values.length, b0 + sb.values.length); // exclusive
	if (to <= from) return null;

	const byYear = new Map<number, { days: number; va: number; vb: number }>();
	for (let day = from; day < to; day++) {
		const va = sa.values[day - a0];
		const vb = sb.values[day - b0];
		if (va == null || vb == null || !Number.isFinite(va) || !Number.isFinite(vb)) continue;
		const wy = waterYearOf(day);
		const y = byYear.get(wy) ?? { days: 0, va: 0, vb: 0 };
		y.days++;
		y.va += va * M3S_TO_MM3_PER_DAY;
		y.vb += vb * M3S_TO_MM3_PER_DAY;
		byYear.set(wy, y);
	}
	if (byYear.size === 0) return null;

	const years: AgreementYear[] = [...byYear.entries()]
		.sort(([x], [y]) => x - y)
		.map(([waterYear, y]) => {
			const ratio = y.vb > 0 ? y.va / y.vb : null;
			const outOfBand = ratio === null ? y.va > 0 : ratio < minRatio || ratio > maxRatio;
			return {
				waterYear,
				days: y.days,
				volumeAMm3: y.va,
				volumeBMm3: y.vb,
				ratio,
				flagged: y.days >= minDays && outOfBand
			};
		});
	return { a, b, minRatio, maxRatio, minDays, years, flaggedYears: years.filter((y) => y.flagged).map((y) => y.waterYear) };
}

/** "2016/17" for water year 2016. */
export const waterYearLabel = (wy: number) => `${wy}/${String((wy + 1) % 100).padStart(2, '0')}`;

/** One human-readable warning for the flagged years, or null. */
export function agreementWarning(ag: ObservedAgreement | null): string | null {
	if (!ag || ag.flaggedYears.length === 0) return null;
	const parts = ag.years
		.filter((y) => y.flagged)
		.map((y) => (y.ratio === null ? `${waterYearLabel(y.waterYear)}: the ${OBSERVED_FLOW_LABEL[ag.b]} recorded nothing` : `${waterYearLabel(y.waterYear)}: ${Math.round(y.ratio * 100)} %`));
	return (
		`Observed flow records disagree — the ${OBSERVED_FLOW_LABEL[ag.a]} as a share of the ${OBSERVED_FLOW_LABEL[ag.b]} volume ` +
		`(days both have readings; expected ${Math.round(ag.minRatio * 100)}–${Math.round(ag.maxRatio * 100)} %): ${parts.join('; ')}. ` +
		`Check which record to calibrate against (Settings → calibration flow series).`
	);
}
