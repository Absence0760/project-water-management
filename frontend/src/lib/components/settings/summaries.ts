// One line under each Settings & calibration panel's heading saying what it is
// set to now (issue #468), so the page reads as a list of current values and a
// panel needn't be scanned field by field to know whether it matters. They
// follow the unsaved form. Pure: SettingsTab passes the derived figures in.
import { ALLOCATION_MODE_LABEL, defaultDataQualitySettings, type ProjectSettings } from '@water-management/engine';
import type { AutoRunSettings, OutcomeSettings, OutlookSettings } from '$lib/api/types';
import { fmtDay, fmtNum, fmtPct, fmtQty } from '$lib/format/number';
import type { SettingsSectionId } from './sections';

export interface SummaryInput {
	s: ProjectSettings & { autoRun?: Partial<AutoRunSettings>; outcomes?: OutcomeSettings; outlook?: OutlookSettings };
	/** The sum of the hydrological units' areas (km²), the catchment area when none is set. */
	unitAreaKm2: number;
	/** The PE GR4J runs on in a year (mm). */
	peAnnualMm: number;
	/** The pragmatic EWR in a year (Mm³). */
	ewrAnnualMm3: number;
	/** Where the daily EWR at the outlet comes from (the EWR panel's own line). */
	ewrSource: string;
	/** The header's line about the fit (fitSummary). */
	fit: string;
	/** The calibration site's name when it isn't the outlet. */
	siteName?: string | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "1 Oct 2015 – 30 Sep 2020", "from 1 Oct 2015", "to …", or null for neither. */
export function dateSpan(start: string | null | undefined, end: string | null | undefined): string | null {
	if (start && end) return `${fmtDay(start)} – ${fmtDay(end)}`;
	if (start) return `from ${fmtDay(start)}`;
	if (end) return `to ${fmtDay(end)}`;
	return null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtMonthDay = (month: number, day: number) => `${day} ${MONTHS[month - 1] ?? month}`;

/** How many of the data-quality limits differ from their defaults (a missing one is the default). */
export function changedLimits(dq: Record<string, unknown> | undefined): number {
	if (!dq) return 0;
	const d = defaultDataQualitySettings() as unknown as Record<string, unknown>;
	return Object.keys(d).filter((k) => k in dq && JSON.stringify(dq[k]) !== JSON.stringify(d[k])).length;
}

export function settingsSummaries(i: SummaryInput): Partial<Record<SettingsSectionId, string>> {
	const s = i.s;
	const apan = (s.apanMm ?? []).reduce((t, v) => t + (v || 0), 0);
	const ranges = Array.isArray(s.chirpsFitPeriod) ? s.chirpsFitPeriod.length : 0;
	const bias = s.chirpsBiasCorrection === 'none' ? 'Raw CHIRPS fills gaps' : 'CHIRPS bias-corrected per month fills gaps';
	const zr = s.zeroRainRuns;
	const restrict = s.droughtRestriction;
	const exclusions = s.calibrationExclusions?.length ?? 0;
	const area = s.calibration?.catchmentAreaKm2 ?? null;
	const g = s.gr4j;
	const span = dateSpan(s.calibrationStart, s.calibrationEnd);
	const share =
		s.flowShareMethod === 'hiLo'
			? `High/low MAP split, ${fmtPct(s.hiLoSplit?.hi ?? 0, 0)} / ${fmtPct(s.hiLoSplit?.lo ?? 0, 0)}`
			: s.flowShareMethod === 'manual'
				? 'Manual share per hydrological unit'
				: 'By catchment area';
	const auto = s.autoRun;
	return {
		'set-period': dateSpan(s.simulationStart, s.simulationEnd) ?? 'The whole rain record',
		'set-rain': [
			bias + (s.chirpsBiasCorrection !== 'none' && s.chirpsQuantileMap ? ', quantile-mapped' : ''),
			s.chirpsBiasCorrection === 'none' ? null : ranges ? `fitted on ${plural(ranges, 'range')} of years` : 'fitted on the whole record',
			zr?.mode === 'asRecorded' ? 'zero runs as recorded' : 'zero runs treated as missing',
			s.rainSource?.length ? plural(s.rainSource.length, 'rain-source period') : null
		]
			.filter(Boolean)
			.join(' · '),
		'set-demand': [
			`A-pan ${fmtNum(apan)} mm a year`,
			`effective rain ${fmtPct(s.effectiveRainFraction ?? 0, 0)}`,
			`soil-water store ${fmtNum(s.effectiveRainStoreMm ?? 0)} mm`,
			s.lakeEvapFactorMonthly ? 'dam evaporation by month' : `dam evaporation ${fmtNum(s.lakeEvapFactor ?? 0, 2, true)} × A-pan`
		].join(' · '),
		'set-share': share,
		'set-restrict': restrict ? `On: ${plural(restrict.levels?.length ?? 0, 'level')}, reviewed on ${plural(restrict.reviewDates?.length ?? 0, 'date')}` : 'Off',
		'set-flow': [
			g ? `GR4J X1 ${fmtNum(g.x1, 0)} mm, X3 ${fmtNum(g.x3, 0)} mm, X4 ${fmtNum(g.x4, 2, true)} days${g.x2 ? `, X2 ${fmtNum(g.x2, 2, true)} mm` : ''}` : 'GR4J',
			`${fmtNum(area != null && area > 0 ? area : i.unitAreaKm2, 1, true)} km²`,
			`PE ${fmtNum(i.peAnnualMm)} mm a year${s.pe?.kind === 'monthly' ? ' (monthly PE)' : ''}`,
			s.arealRain ? 'areal correction on' : null
		]
			.filter(Boolean)
			.join(' · '),
		'set-record': [
			span ?? 'The whole flow record',
			i.siteName ? `at ${i.siteName}` : 'at the outlet',
			exclusions ? `${plural(exclusions, 'period')} left out` : null
		]
			.filter(Boolean)
			.join(' · '),
		'set-fit': i.fit,
		'set-ewr': [
			i.ewrSource,
			s.ewrDailySource && s.ewrDailySource.method !== 'pragmatic' ? null : `${fmtQty(i.ewrAnnualMm3, 3)} Mm³ a year`,
			dateSpan(s.reportStart, s.reportEnd) ? `reporting ${dateSpan(s.reportStart, s.reportEnd)}` : null,
			`registered volumes: ${ALLOCATION_MODE_LABEL[s.allocationMode ?? 'none'].toLowerCase()}`
		]
			.filter(Boolean)
			.join(' · '),
		'set-wr2012': s.wr2012?.reference
			? `On: quaternary ${s.wr2012.reference.quaternary || '(unnamed)'}, MAR ${fmtQty(s.wr2012.reference.marMm3, 3)} Mm³`
			: 'Off: runs aren’t compared with WR2012',
		'set-reserve': s.ewrRules?.length
			? `${plural(s.ewrRules.length, 'rule table')} · the EWR charge follows ${s.ewrChargeSource === 'ruleTable' ? 'the rule tables' : 'the pragmatic EWR'}`
			: // The panel's own line says what having none means.
				'',
		'set-quality': (() => {
			const changed = changedLimits(s.dataQuality as unknown as Record<string, unknown> | undefined);
			return changed ? `${plural(changed, 'limit')} changed from the defaults` : 'The default limits';
		})(),
		'set-outcomes': (() => {
			const o = s.outcomes;
			const m = o?.yearClassMethod ?? 'auto';
			const classes = m === 'terciles' ? 'Terciles' : m === 'quintiles' ? 'Quintiles' : 'Automatic year classes';
			return `${classes}${o?.siteNodeId ? '' : ' · read at the outlet'}`;
		})(),
		'set-outlook': (() => {
			const o = s.outlook;
			const season = o?.season ? `Season ${fmtMonthDay(o.season.startMonth, o.season.startDay)} – ${fmtMonthDay(o.season.endMonth, o.season.endDay)}` : 'The default season';
			return o?.planningShare != null ? `${season} · planning share ${fmtPct(o.planningShare, 0)}` : season;
		})(),
		'set-evidence': s.evidenceUncertaintyRule ? 'An uncertainty rule is declared' : 'No uncertainty rule declared',
		'set-auto': auto?.enabled
			? `On: ${fmtNum(auto.debounceMinutes ?? 0)} minutes after new data, ${auto.publish === 'if_no_new_warnings' ? 'publishes if no new warnings' : 'never publishes'}`
			: 'Off: runs only when someone runs the model'
	};
}
