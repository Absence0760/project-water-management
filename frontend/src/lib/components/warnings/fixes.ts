// How each warning on the Warnings page is solved (issue #611): a line in plain
// words and one primary action. Every run warning code (engine
// warningCodes.ts WARNING_CODES) has an entry here, which fixes.test.ts holds
// to: a code added to the engine without one fails the test.
//
// The actions:
// - 'setting': a one-value settings change the page saves at once (the
//   settings PATCH, with a reason), only where the setting really is one value
//   and the change can't lose anything: the flagged-rain modes, and dropping a
//   station's malformed unreliable periods. `applied` says whether the saved
//   settings already hold it, so the row reads "Fixed: rerun to confirm" until
//   a run no longer warns;
// - 'field': the exact field that changes it, `?tab=<page>&field=<id>`; the
//   workspace page lands there (nav/fieldLanding.ts: opens its fold, scrolls
//   to it, focuses and highlights it);
// - 'link': a page or panel (Data feeds, Add data, the Network);
// - 'filter': this page's own data-check rows (a data-check warning is solved
//   period by period there).
// Uncoded warnings (an older run, a warning not coded yet) take an action by
// their words (uncodedFix), else the guide to reading a run's results.
import {
	defaultZeroRainSettings,
	isIsoDate,
	WARNING_CODES,
	type ProjectSettings,
	type WarningCode,
	type WarningParams
} from '@water-management/engine';
import type { SettingsPatch } from './items';

export type FixAction =
	| {
			kind: 'setting';
			label: string;
			/** Where the setting is, for a reader who can't save it and once it is saved. */
			href: string;
			patch: (s: ProjectSettings, params: WarningParams) => SettingsPatch;
			applied: (s: ProjectSettings, params: WarningParams) => boolean;
	  }
	| { kind: 'field'; label: string; href: string }
	| { kind: 'link'; label: string; href: string }
	| { kind: 'filter'; label: string; href: string };

export interface Fix {
	/** What is wrong and what to do, in one or two plain sentences. */
	how: string;
	action: FixAction;
}

/** A field on a settings page: the workspace page lands on it (`field=`). */
const field = (tab: 'settings' | 'calibration', id: string, label: string): FixAction => ({ kind: 'field', label, href: `?tab=${tab}&field=${encodeURIComponent(id)}` });
const checks = (check: string, label: string): FixAction => ({ kind: 'filter', label, href: `?tab=warnings&source=checks&status=open&check=${check}` });

const zeroRain = (s: ProjectSettings) => ({ ...defaultZeroRainSettings(), ...(s.zeroRainRuns ?? {}) });
const SET_ASIDE: FixAction = {
	kind: 'setting',
	label: 'Set flagged zero runs aside',
	href: '?tab=settings&field=st-zero-rain',
	patch: (s) => ({ zeroRainRuns: { ...zeroRain(s), mode: 'missing' } }),
	applied: (s) => zeroRain(s).mode === 'missing'
};
const SPREAD: FixAction = {
	kind: 'setting',
	label: 'Spread accumulations',
	href: '?tab=settings&field=st-acc',
	patch: (s) => ({ zeroRainRuns: { ...zeroRain(s), accumulationMode: 'spread' } }),
	applied: (s) => zeroRain(s).accumulationMode === 'spread'
};
const validPeriod = (p: unknown) => Array.isArray(p) && isIsoDate(p[0]) && isIsoDate(p[1]) && p[0] <= p[1];
const DROP_INVALID: FixAction = {
	kind: 'setting',
	label: 'Remove the broken periods',
	href: '?tab=settings&field=fld-rain-unreliable',
	patch: (s, params) => {
		const id = String(params.station ?? params.unit ?? '');
		const unreliable = { ...(s.rainStations?.unreliable ?? {}) };
		const kept = (unreliable[id] ?? []).filter(validPeriod);
		if (kept.length) unreliable[id] = kept as [string, string][];
		else delete unreliable[id];
		return { rainStations: { ...(s.rainStations ?? {}), unreliable } };
	},
	applied: (s, params) => (s.rainStations?.unreliable?.[String(params.station ?? params.unit ?? '')] ?? []).every(validPeriod)
};

const ZERO_MODE = field('settings', 'st-zero-rain', 'Go to Flagged zero runs');
const ZERO_FILL = field('settings', 'st-zero-rain-mm', 'Go to the CHIRPS threshold');
const KEEP_DRY = field('settings', 'fld-keep-dry', 'Go to Keep dry');
const ACC_MODE = field('settings', 'st-acc', 'Go to Multi-day accumulations');
const KEEP_READINGS = field('settings', 'fld-keep-readings', 'Go to Keep as recorded');
const CHIRPS_BIAS = field('settings', 'st-chirps-bias', 'Go to CHIRPS correction');
const CHIRPS_FIT = field('settings', 'fld-chirps-fit', 'Go to the CHIRPS fit period');
const GAP_RAIN = field('settings', 'fld-gap-rain', 'Go to the gap-filling product');
const RAIN_SOURCE = field('settings', 'fld-rain-source', 'Go to Rain source periods');
const UNRELIABLE = field('settings', 'fld-rain-unreliable', 'Go to Unreliable periods');
const STATIONS = field('settings', 'fld-stations', 'Go to the stations');
const UNIT_RAIN = field('settings', 'set-unit-rain', 'Go to Unit rain');
const SIM_PERIOD = field('settings', 'st-start', 'Go to Simulation period');
const CAL_WINDOW = field('calibration', 'fld-cal-window', 'Go to the calibration window');
const CAL_EXCLUSIONS = field('calibration', 'fld-cal-exclusions', 'Go to Excluded periods');
const CAL_ZONES = field('calibration', 'fld-cal-zones', 'Go to Calibrate at several gauges');
const FIT = field('calibration', 'set-fit', 'Go to Fit the parameters');
const FLOW_GENERATION: FixAction = { kind: 'link', label: 'Go to Model selection for flow generation', href: '?tab=settings#set-share' };
const FEEDS: FixAction = { kind: 'link', label: 'Go to Data feeds', href: '?tab=series#data-feeds' };
const ADD_DATA: FixAction = { kind: 'link', label: 'Add data', href: '?tab=series&add=data' };
const DATA: FixAction = { kind: 'link', label: 'Go to Data', href: '?tab=series' };

/** Every run warning code's fix. */
export const CODE_FIXES: Record<WarningCode, Fix> = {
	'data.negative': { how: 'A record has negative values. Decide each period under Data checks: patch it (rain) or exclude it from calibration (flow), or keep it.', action: checks('negative', 'Show the periods') },
	'data.outlier': { how: 'A record has values far above the rest. Look at each period under Data checks, then patch, exclude or keep it.', action: checks('outlier', 'Show the periods') },
	'data.flatline': { how: 'A record repeats one value for days, as a stuck logger or a filled-in gap does. Decide each stretch under Data checks.', action: checks('flatline', 'Show the periods') },
	'data.zerorun': { how: 'The catchment rain reads 0 for a long wet-season stretch, which may be missing data. Decide each run under Data checks: patch it or keep it dry.', action: checks('zerorun', 'Show the periods') },
	'data.lowvschirps': { how: 'Some water years read far less rain than CHIRPS. Patch the years you trust less under Data checks, or keep them.', action: checks('lowvschirps', 'Show the periods') },
	'data.doublemass': { how: 'The catchment rain’s double-mass curve against CHIRPS breaks: the gauge or its site may have changed. Fit the CHIRPS factors on the years after the break.', action: CHIRPS_FIT },
	'data.flowAgreement': { how: 'The gauge and the logger records disagree in some years. Choose the record you trust to calibrate against.', action: field('calibration', 'fld-cal-window', 'Go to Compare with') },

	'rain.zeroRun.missing': { how: 'Flagged zero runs are set aside and filled from CHIRPS, as set up. Nothing to do unless a run was a real dry spell: then keep it dry.', action: KEEP_DRY },
	'rain.zeroRun.keptDry': { how: 'Zero runs you kept dry stay 0 mm. Check each is a real dry spell; remove one from Keep dry if CHIRPS saw rain.', action: KEEP_DRY },
	'rain.zeroRun.chirpsDry': { how: 'Days of flagged zero runs stay dry where CHIRPS reads little rain. Raise or lower the CHIRPS threshold if that split looks wrong.', action: ZERO_FILL },
	'rain.zeroRun.asRecorded': { how: 'Flagged zero runs are run as dry days, so CHIRPS doesn’t fill them. Set them aside so a run fills them, unless they were real dry spells.', action: SET_ASIDE },
	'rain.keepDry.doubtful': { how: 'CHIRPS reads a lot of rain over a run you kept dry. Check it, and take it out of Keep dry if it was missing data.', action: KEEP_DRY },
	'rain.accumulation.spread': { how: 'Multi-day accumulations are spread over the days they cover, as set up. Keep a reading as one day’s rain if it really fell in a day.', action: KEEP_READINGS },
	'rain.accumulation.noChirps': { how: 'Accumulations were spread evenly because there is no CHIRPS series to shape them. Add a CHIRPS feed on Data.', action: FEEDS },
	'rain.accumulation.setAside': { how: 'Some accumulation readings were set aside as missing. Check the accumulations setting.', action: ACC_MODE },
	'rain.accumulation.kept': { how: 'Readings you kept as one day’s rain stay on their day. Check each is a real one-day storm.', action: KEEP_READINGS },
	'rain.accumulation.asRecorded': { how: 'Multi-day accumulations run as one day’s rain, which can make one day far too wet. Spread them over the days they cover.', action: SPREAD },
	'rain.accumulation.noReading': { how: 'An accumulation listed by hand has no reading on its last day, so nothing was spread. Check the listed accumulations.', action: ACC_MODE },
	'rain.chirps.corrected': { how: 'CHIRPS filled gaps in the catchment rain, corrected by monthly factors. Nothing to do unless the factors look wrong.', action: CHIRPS_BIAS },
	'rain.chirps.uncorrected': { how: 'CHIRPS filled gaps uncorrected: too few days to fit factors. Fit them on a longer period, or check the catchment rain overlaps CHIRPS.', action: CHIRPS_FIT },
	'rain.chirps.quantileMapFallback': { how: 'Quantile mapping couldn’t map some months and used the monthly factors there. Check the CHIRPS correction.', action: CHIRPS_BIAS },
	'rain.chirps.doubleMassBreak': { how: 'CHIRPS against the catchment rain breaks in its double-mass curve. Fit the CHIRPS factors on the years after the break.', action: CHIRPS_FIT },
	'rain.gapProduct.absent': { how: 'The chosen gap-filling product has no data loaded. Load it on Data, or choose another product.', action: GAP_RAIN },
	'rain.gapProduct.uncorrected': { how: 'The gap-filling product filled days uncorrected: too few days to fit a factor. Choose another product, or accept it.', action: GAP_RAIN },
	'rain.gapProduct.corrected': { how: 'The gap-filling product filled days, corrected. Nothing to do unless the correction looks wrong.', action: GAP_RAIN },
	'rain.gapProduct.doubleMassBreak': { how: 'The gap-filling product breaks against the catchment rain. Check the product, or choose another.', action: GAP_RAIN },
	'rain.sourcePeriod': { how: 'A rain source period has a problem (its series is missing or it overlaps). Check the rain source periods.', action: RAIN_SOURCE },
	'rain.missingDays': { how: 'Some days had no rain from any source and ran dry. Add rain for them, or a CHIRPS feed to fill them.', action: FEEDS },
	'rain.none': { how: 'The run had no rain series. Add the catchment rain on Data.', action: ADD_DATA },
	'rain.chirpsShadowed': { how: 'Two CHIRPS series, and the run reads only the first by name. Rename or delete the other on Data.', action: DATA },
	'rain.station.noRecord': { how: 'A unit’s rain station has no record. Pick another station, or load its record.', action: STATIONS },
	'rain.station.unreliableInvalid': { how: 'A station has an unreliable period that isn’t two dates in order, so it is ignored. Remove it, or fix its dates.', action: DROP_INVALID },
	'rain.station.unreliable': { how: 'Periods you marked unreliable on a station were read as missing. Nothing to do unless one is wrong.', action: UNRELIABLE },
	'rain.station.zeroRun.missing': { how: 'A station’s flagged zero runs were set aside, as the catchment’s setting says. Nothing to do unless one was a real dry spell.', action: ZERO_MODE },
	'rain.station.zeroRun.asRecorded': { how: 'A station’s flagged zero runs run as dry days. Set flagged zero runs aside so they are filled.', action: SET_ASIDE },
	'rain.station.accumulation.spread': { how: 'A station’s accumulations were spread over their days. Nothing to do unless one was a real one-day storm.', action: ACC_MODE },
	'rain.station.accumulation.setAside': { how: 'A station’s accumulation readings were set aside as missing. Check the accumulations setting.', action: ACC_MODE },
	'rain.station.accumulation.asRecorded': { how: 'A station’s accumulations run as one day’s rain. Spread them over the days they cover.', action: SPREAD },
	'rain.unitGauge.zeroRun.missing': { how: 'A unit gauge’s flagged zero runs were set aside. Nothing to do unless one was a real dry spell.', action: ZERO_MODE },
	'rain.unitGauge.zeroRun.asRecorded': { how: 'A unit gauge’s flagged zero runs run as dry days. Set flagged zero runs aside so they are filled.', action: SET_ASIDE },
	'rain.unitGauge.accumulation.spread': { how: 'A unit gauge’s accumulations were spread over their days. Nothing to do unless one was a real one-day storm.', action: ACC_MODE },
	'rain.unitGauge.accumulation.setAside': { how: 'A unit gauge’s accumulation readings were set aside as missing. Check the accumulations setting.', action: ACC_MODE },
	'rain.unitGauge.accumulation.asRecorded': { how: 'A unit gauge’s accumulations run as one day’s rain. Spread them over the days they cover.', action: SPREAD },
	'rain.unitGauge.unreliable': { how: 'Periods you marked unreliable on a unit gauge were read as missing. Nothing to do unless one is wrong.', action: UNRELIABLE },
	'rain.unit.catchmentFallback': { how: 'A unit’s rain rule found nothing and fell back to the catchment’s rain. Give the unit a gauge, CHIRPS or a station.', action: UNIT_RAIN },

	'calibration.noObserved': { how: 'No observed flow record, so the run has no calibration scores. Add a gauge or logger record on Data.', action: ADD_DATA },
	'calibration.allExcluded': { how: 'Every day of the record is excluded from calibration. Narrow the excluded periods.', action: CAL_EXCLUSIONS },
	'calibration.noValuesInWindow': { how: 'The calibration window holds no observed flow. Move the window onto the record’s years.', action: CAL_WINDOW },
	'calibration.noValuesInPeriod': { how: 'The simulation period holds no observed flow. Widen the simulation period, or load the record for those years.', action: SIM_PERIOD },
	'calibration.windowReversed': { how: 'The calibration window ends before it starts, so the whole record was scored. Swap its dates.', action: CAL_WINDOW },
	'calibration.flowKindMissing': { how: 'The record the calibration compares with isn’t loaded. Choose another, or load it.', action: CAL_WINDOW },
	'calibration.defaultGaugePick': { how: 'No record was chosen, so the run picked one. Choose the record to compare with.', action: CAL_WINDOW },
	'calibration.site.unusable': { how: 'The gauge calibration is scored at can’t be used. Choose another site or the outlet.', action: CAL_WINDOW },
	'calibration.site.noRecord': { how: 'The gauge calibration is scored at has no flow record. Attach one on Data, or choose the outlet.', action: CAL_WINDOW },

	'calibration.zone.notList': { how: 'The stored calibration zones couldn’t be read, so the run calibrated at one site. Tick the gauges to calibrate at again.', action: CAL_ZONES },
	'calibration.zone.noGauge': { how: 'A stored calibration zone names no gauge and was ignored. Tick the gauges to calibrate at again.', action: CAL_ZONES },
	'calibration.zone.duplicate': { how: 'A gauge has two calibration zone rows; the run used the first. Check that gauge’s row.', action: CAL_ZONES },
	'calibration.zone.badParams': { how: 'A zone’s GR4J parameters are outside the bounds, so its units ran on the catchment’s. Fit the zone again.', action: FIT },
	'calibration.zone.needsPerUnit': { how: 'Gauges are ticked to calibrate at, but zones need Per unit flow generation. Switch to Per unit, or untick the gauges.', action: FLOW_GENERATION },
	'calibration.zone.unusable': { how: 'A ticked gauge can’t hold a zone (gone, not a gauge, or at or below the site), so its units joined the zone below. Untick it.', action: CAL_ZONES },
	'calibration.zone.unfitted': { how: 'A calibration zone has no parameters of its own yet, so its units ran on the catchment’s. Fit the parameters.', action: FIT },
	'calibration.zone.siteOnlyElsewhere': { how: 'Some units ran on their zone’s parameters, but the report, evidence pack, uncertainty ensemble and automated calibration use only the site’s. Keep it in mind.', action: CAL_ZONES },
	'map.areaFromEarlierOutline': {
		how: 'The unit’s polygon on the map was redrawn after its area was taken from it. Use the new area from the Map’s Checks, or keep the old one if the redraw was a mistake.',
		action: { kind: 'link', label: 'Go to the Map’s Checks', href: '?tab=map&checks=1' }
	}
};

/** The fix of a coded warning; null for a code this client doesn't know (a newer engine). */
export function codeFix(code: string): Fix | null {
	return Object.hasOwn(WARNING_CODES, code) ? CODE_FIXES[code as WarningCode] : null;
}

/** An uncoded warning's fix, by its words (as runs/credibility.ts groups them), else the guide to reading a run. */
export function uncodedFix(text: string, guideHref: string): Fix {
	const t = text.toLowerCase();
	const rule = UNCODED.find((r) => r.test.test(t));
	return rule ? { how: rule.how, action: rule.action } : { how: 'Read what the run says and whether it changes how you use the results. Keep it once you have.', action: { kind: 'link', label: 'How to read run warnings', href: guideHref } };
}

const UNCODED: { test: RegExp; how: string; action: FixAction }[] = [
	{ test: /flat stretch/, how: 'A record repeats one value for days. Decide each stretch under Data checks.', action: checks('flatline', 'Show the periods') },
	{ test: /zero rain|zero-rain|rain treated as missing/, how: 'Zero rain runs may be missing data. Check how flagged zero runs are handled.', action: ZERO_MODE },
	{ test: /accumulation/, how: 'Multi-day accumulations: check how they are handled.', action: ACC_MODE },
	{ test: /chirps/, how: 'CHIRPS stood in for missing rain. Check the CHIRPS correction.', action: CHIRPS_BIAS },
	{ test: /full-supply area|dam evaporation/, how: 'Some dams have no full-supply area, so their evaporation uses an estimate. Enter each dam’s area on the Network.', action: { kind: 'link', label: 'Go to the Network', href: '?tab=network' } },
	{ test: /signature|plausibility|low flows/, how: 'The model’s flows behave unlike the river’s. Read the plausibility checks on Calibration, and adjust the runoff parameters.', action: { kind: 'link', label: 'Go to Plausibility checks', href: '?tab=calibration#res-plausibility' } },
	{ test: /ewr|reserve/, how: 'Something about the EWR. Check the EWR settings.', action: field('settings', 'set-ewr', 'Go to EWR') },
	{ test: /evaporation|a-pan|pan coefficient/, how: 'Something about evaporation. Check the evaporation inputs on Calibration.', action: field('calibration', 'set-flow', 'Go to Flow calibration') },
	{ test: /transfer/, how: 'A transfer rule has a problem. Check it on Transfers.', action: { kind: 'link', label: 'Go to Transfers', href: '?tab=transfers' } },
	{ test: /crop|planted/, how: 'Something about the crops or plantings. Check Crops & demand.', action: { kind: 'link', label: 'Go to Crops & demand', href: '?tab=crops' } }
];
