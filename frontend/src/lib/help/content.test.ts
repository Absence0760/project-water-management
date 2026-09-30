import {
	defaultProjectSettings,
	SERIES_KINDS,
	type CalibrationStats,
	type CropArea,
	type CropDef,
	type DemandObject,
	type FarmSummary,
	type NetworkNode,
	type ProjectSettings,
	type RunSummary,
	type Transfer
} from '@water-management/engine';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildPreviewColumns, PREVIEW_DATE_HELP_KEY } from '../components/series/preview';
import { ARTICLES } from './articles';
import { DATA_ARTICLES } from './articles-data';
import { CATEGORY_TITLES, countryNames, HELP, helpFieldKeys, helpFor, searchHelp } from './content';
import { FARMER_HELP } from './farmer';
import { TIPS, tipFor } from './tips';

// Exhaustive `Record<keyof T, true>` objects: the typecheck fails if the engine
// renames a field, so help keys can't silently drift from the model.
const NODE: Record<keyof NetworkNode, true> = {
	id: true, name: true, kind: true, downstreamNodeId: true, sortOrder: true, areaKm2: true, areaHiKm2: true,
	areaLoKm2: true, flowShareManual: true, pctUpstreamToDam: true, pctRunoffToDam: true, damCapacityM3: true,
	damInitialPct: true, damMinPct: true, divertCapacityM3Day: true, irrigationEfficiency: true, lossReturnFraction: true,
	damAreaFullM2: true, damAreaExponent: true, damSeepagePerDay: true,
	userDemandM3Day: true, userReturnPct: true, userPriority: true,
	boreholeCapacityM3Day: true, boreholeRule: true, boreholeTriggerPct: true, streamDepletionFrac: true, streamDepletionLagDays: true,
	damCurve: true, damReleaseRule: true, damReleaseM3Day: true, damOutletCapacityM3Day: true, damSeepageReturnPct: true,
	demandFactor: true, partDemandFactor: true, supplyRule: true, pumpCapacityM3Day: true, supplyTriggerPct: true, supplyStopPct: true, ewrSite: true,
	gaPropertyAreaHa: true, gaRateM3HaYear: true,
	damSurveyDate: true, damSedimentPctPerYear: true, damInServiceFrom: true, abstractionFrom: true,
	handsOffM3Day: true, handsOffEwr: true, divertMonthlyM3Day: true
};
const CROP: Record<keyof CropDef, true> = { id: true, name: true, sortOrder: true, cropFactor: true, irrigationEfficiency: true };
const CROP_AREA: Record<keyof CropArea, true> = { nodeId: true, cropId: true, areaM2: true };
const TRANSFER: Record<keyof Transfer, true> = {
	id: true, fromNodeId: true, toNodeId: true, months: true, maxRateM3s: true, dailyCapM3: true, minStoragePct: true, enabled: true,
	priority: true, monthlyRateM3s: true, source: true, handsOffM3Day: true, handsOffEwr: true, lossPct: true, sizing: true, topUpDam: true,
	lossReturnPct: true, lossReturnNodeId: true
};
const SUMMARY: Record<keyof FarmSummary, true> = {
	nodeId: true, name: true, avgDemandM3Day: true, avgSuppliedM3Day: true, avgDeficitM3Day: true,
	fractionSupplied: true, avgEwrShortfallM3Day: true, daysEwrNotMet: true, avgCropRequirementM3Day: true,
	avgGroundwaterM3Day: true, avgBaseflowDepletionM3Day: true, avgGroundwaterToDamM3Day: true, flowShare: true,
	avgRiverAbstractionM3Day: true, damEndM3: true, damAgoM3: true, damLowM3: true, damLowDate: true, damDaysAtMin: true,
	demandObjects: true
};
const DEMAND_OBJECT: Record<keyof DemandObject, true> = {
	id: true, nodeId: true, name: true, category: true, sizing: true, monthlyM3Day: true, count: true, litresPerUnitDay: true, lossPct: true,
	monthlyFactor: true, returnPct: true, priority: true, destination: true, enabled: true, schedule: true, population: true, note: true
};
const CATCHMENT: Record<keyof RunSummary['catchment'], true> = {
	meanNaturalFlowM3Day: true, meanSimulatedOutflowM3Day: true, runoffCoefficient: true, ewrDaysNotMet: true,
	ewrFractionDaysNotMet: true, ewrAgreement: true, ewrAgreementSites: true, noFlow: true
};
const STATS: Record<keyof CalibrationStats, true> = {
	days: true, nse: true, pbias: true, rmseM3s: true, meanObservedM3s: true, meanSimulatedM3s: true,
	windowStart: true, windowEnd: true, firstObservedDate: true, lastObservedDate: true, kge: true, kgeR: true,
	kgeAlpha: true, kgeBeta: true, r2: true, logNse: true, logEpsilonM3s: true, volumeErrorPct: true,
	annualVolumes: true, flowKind: true, simulatedKey: true, exclusions: true, excludedDays: true, fitStatus: true, wr2012Fit: true,
	siteNodeId: true, siteName: true
};
// Run series keys emitted by packages/engine/src/run.ts and flow.ts.
const RUN_KEYS = [
	'natural_flow', 'simulated_outflow', 'observed_flow', 'observed_flow_other', 'ewr', 'ewr_shortfall', 'rain_used', 'is_summer', 'rain_flow',
	'base_flow', 'response_flow', 'resultant_flow', 'rain_final', 'rain_areal', 'rain_chirps', 'rain_chirps_corrected', 'chirps_factor', 'rain_catchment_missing', 'rain_catchment_spread', 'rain_source', 'crop_requirement', 'demand', 'supplied', 'deficit', 'inflow_upstream', 'runoff',
	'transfer', 'dam_storage', 'spill', 'outflow', 'ewr_cumulative', 'ewr_shortfall_incremental',
	// A dam's capacity on the day, when sediment or an in-service date changes it (engine 1.30.0, issue #67)
	'dam_capacity',
	// EWR attribution (engine 0.17.0, audit Q17)
	'ewr_charged', 'ewr_natural', 'ewr_charge', 'ewr_charge_irrigation',
	// The EWR site that set a farm's charge each day (engine 1.5.0)
	'ewr_binding_site',
	// The Reserve rule table's monthly requirement (engine 0.21.0)
	'ewr_rule',
	// The shortfall a rule-table site's charge follows (engine 1.3.0, settings.ewrChargeSource)
	'ewr_charge_shortfall',
	// Farm working columns (engine 0.12.0, packages/engine/src/verify/columns.ts)
	'gross_demand', 'effective_rain', 'soil_water', 'upstream_to_dam', 'upstream_below_dam', 'runoff_to_dam', 'runoff_below_dam',
	'diverted_to_dam', 'interim_storage', 'below_dam_not_diverted', 'return_flow', 'balance_residual',
	// Dam evaporation, rain on the dam and seepage (engine 0.16.0, audit N2)
	'dam_area', 'rain_on_dam', 'dam_evaporation', 'dam_seepage',
	// Dam releases and seepage lost (engine 0.35.0, WP-3.5)
	'dam_release', 'dam_seepage_lost',
	// Other water users (engine 0.22.0, WP-1.33)
	'senior_requirement', 'passed_for_senior',
	// Boreholes (engine 0.23.0, WP-1.34); depletion_unmet on runs before engine 1.10.0, depletion_deficit from it
	'groundwater_used', 'baseflow_depletion', 'depletion_unmet', 'depletion_deficit', 'depletion_store',
	// Boreholes that pump into the dam (engine 0.36.0, WP-3.9)
	'groundwater_to_dam',
	// The river pump of a farm's supply rule (engine 0.42.0, WP-3.8)
	'river_abstraction',
	// Land cover (engine 0.24.0, WP-1.35)
	'landcover_reduction',
	// Gap filling of the observed flow records (engine 1.23.0, issue #66)
	'observed_flow_fill', 'observed_flow_filled', 'observed_flow_other_fill', 'observed_flow_other_filled',
	// The scored record's per-day quality flags (engine 1.48.0, CR-18)
	'observed_flow_quality',
	// GR4J (packages/engine/src/runoff/simulate.ts)
	'pet', 'aet', 'production_store', 'routing_store', 'uh_store', 'exchange'
];

// The daily preview's derived columns (series/preview.ts), from every series kind at once.
const PREVIEW_KEYS = [
	PREVIEW_DATE_HELP_KEY,
	...buildPreviewColumns(SERIES_KINDS.map((kind, i) => ({ id: `s${i}`, kind, name: '', unit: '', startDate: '2020-01-01', length: 1 })))
		.map((c) => c.helpKey)
		.filter((k) => k.startsWith('preview.'))
];

const settings = defaultProjectSettings();
// Settings with no default (absent until someone sets them): typed, so each is a real field.
const OPTIONAL_SETTINGS: (keyof ProjectSettings)[] = ['evidenceUncertaintyRule'];
const VALID: Record<string, Set<string>> = {
	node: new Set(Object.keys(NODE)),
	crop: new Set(Object.keys(CROP)),
	cropArea: new Set(Object.keys(CROP_AREA)),
	transfer: new Set(Object.keys(TRANSFER)),
	demandObject: new Set(Object.keys(DEMAND_OBJECT)),
	settings: new Set([...Object.keys(settings), ...OPTIONAL_SETTINGS]),
	calibration: new Set(Object.keys(settings.calibration)),
	series: new Set(SERIES_KINDS),
	summary: new Set(Object.keys(SUMMARY)),
	catchment: new Set(Object.keys(CATCHMENT)),
	stats: new Set(Object.keys(STATS)),
	run: new Set(RUN_KEYS),
	preview: new Set(PREVIEW_KEYS.map((k) => k.slice('preview.'.length)))
};

describe('help content', () => {
	it('has unique, anchor-safe ids', () => {
		const ids = HELP.map((e) => e.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
	});

	it('keeps every short text to one line of ≤ 140 characters', () => {
		for (const e of HELP) {
			expect(e.short.length, e.id).toBeGreaterThan(10);
			expect(e.short.length, `${e.id}: ${e.short.length} chars`).toBeLessThanOrEqual(140);
			expect(e.short, e.id).not.toMatch(/\n/);
			expect(e.long.trim().length, e.id).toBeGreaterThan(0);
			expect(e.source.trim().length, e.id).toBeGreaterThan(0);
			expect(Object.keys(CATEGORY_TITLES), e.id).toContain(e.category);
		}
	});

	it('tags the South African datasets, laws and methods with their country (issue #76)', () => {
		for (const e of HELP) for (const c of e.countries ?? []) expect(c, e.id).toMatch(/^[A-Z]{2}$/);
		const za = HELP.filter((e) => e.countries?.includes('ZA')).map((e) => e.id);
		expect(za.sort()).toEqual(['desktop-reserve-model', 'ga538', 'quaternary', 'wr2012-check', 'wr2012-penalty', 'wr90']);
		expect(countryNames(['ZA'])).toBe('South Africa');
		// An entry that holds anywhere carries no tag.
		expect(helpFor('water-balance')!.countries).toBeUndefined();
	});

	it('only relates to entries that exist (and not to itself)', () => {
		for (const e of HELP) {
			for (const r of e.related ?? []) {
				expect(helpFor(r), `${e.id} → ${r}`).toBeDefined();
				expect(r, e.id).not.toBe(e.id);
			}
		}
	});

	it('gives each field key to exactly one entry, and every key names a real field', () => {
		const seen = new Map<string, string>();
		for (const e of HELP) {
			for (const f of e.fields ?? []) {
				expect(seen.get(f), `${f} in ${e.id} and ${seen.get(f)}`).toBeUndefined();
				seen.set(f, e.id);
				const [ns, name, ...rest] = f.split('.');
				expect(rest, f).toEqual([]);
				expect(VALID[ns!], `unknown namespace in ${f}`).toBeDefined();
				expect(VALID[ns!]!.has(name!), `unknown field ${f}`).toBe(true);
			}
		}
		expect(helpFieldKeys()).toEqual([...seen.keys()].sort());
	});

	it('covers every user-editable model field', () => {
		const skip = new Set(['node.id', 'node.sortOrder', 'crop.id', 'crop.sortOrder', 'cropArea.nodeId', 'cropArea.cropId', 'transfer.id']);
		const editable = [
			...Object.keys(NODE).map((k) => `node.${k}`),
			...Object.keys(CROP).map((k) => `crop.${k}`),
			...Object.keys(CROP_AREA).map((k) => `cropArea.${k}`),
			...Object.keys(TRANSFER).map((k) => `transfer.${k}`),
			...Object.keys(settings).filter((k) => k !== 'calibration').map((k) => `settings.${k}`),
			...Object.keys(settings.calibration).map((k) => `calibration.${k}`),
			...SERIES_KINDS.map((k) => `series.${k}`),
			...PREVIEW_KEYS
		].filter((k) => !skip.has(k));
		const missing = editable.filter((k) => !helpFor(k));
		expect(missing).toEqual([]);
	});

	it('resolves every HelpTip key used in the app', () => {
		const root = fileURLToPath(new URL('../..', import.meta.url)); // frontend/src
		const files: string[] = [];
		const walk = (dir: string) => {
			for (const name of readdirSync(dir)) {
				const p = join(dir, name);
				if (statSync(p).isDirectory()) walk(p);
				else if (p.endsWith('.svelte')) files.push(p);
			}
		};
		walk(root);
		const used: string[] = [];
		for (const f of files) {
			const src = readFileSync(f, 'utf8');
			for (const m of src.matchAll(/<HelpTip\b[^>]*?\bkey=["']([^"']+)["']/g)) used.push(m[1]!);
			// A computed key (`key={col.helpKey}` in SeriesPreviewDialog) isn't seen here: the
			// daily preview's keys are covered by PREVIEW_KEYS above and series/preview.test.ts.
			// Components that place the HelpTip themselves take the key as a helpKey prop (PeriodList).
			for (const m of src.matchAll(/\bhelpKey=["']([^"']+)["']/g)) used.push(m[1]!);
		}
		// HelpTip looks keys up in the tips alone (tipFor), so that is what must find them.
		for (const k of used) expect(tipFor(k), `HelpTip key "${k}"`).toBeDefined();
	});
});

// The glossary is read by hydrologists using the app, who can't open the
// repo: where an idea comes from (`source`: docs/model.md §…, an audit
// finding, an issue) is for maintainers, kept in the data and not shown
// (issue #162). The text a reader sees mustn't point there either.
describe('the glossary’s reader-facing text', () => {
	it('names no developer document, audit finding or issue', () => {
		for (const e of HELP) {
			for (const [part, text] of [
				['term', e.term],
				['short', e.short],
				['long', e.long],
				['units', e.units ?? '']
			] as const) {
				expect(text, `${e.id} ${part}`).not.toMatch(/docs\/|\.md\b|\bissues? #\d|§\s?\d/);
			}
		}
	});

	it('still records a source for every entry, for maintainers', () => {
		for (const e of HELP) expect(e.source.trim(), e.id).not.toBe('');
	});
});

// A HelpTip loads tips.ts alone; the glossary's long text (articles.ts) and
// the farm words (farmer.ts) load only where they're read (tips.ts header).
describe('the help text split', () => {
	const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
	// Static and dynamic import specifiers, and whether each is type-only.
	const imports = (src: string) => [
		...[...src.matchAll(/^\s*import\s+(type\s+)?[^'"]*?\bfrom\s*['"]([^'"]+)['"]/gm)].map((m) => ({ type: Boolean(m[1]), from: m[2]! })),
		...[...src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => ({ type: false, from: m[1]! }))
	];

	it('gives every tip an article and every article a tip, in the same order', () => {
		// Each module in the tips' order; articles-data.ts holds exactly the "Input data" topic.
		const ids = TIPS.map((t) => t.id);
		expect(Object.keys(ARTICLES)).toEqual(ids.filter((id) => TIPS.find((t) => t.id === id)!.category !== 'data'));
		expect(Object.keys(DATA_ARTICLES)).toEqual(ids.filter((id) => TIPS.find((t) => t.id === id)!.category === 'data'));
	});

	it('keeps the farm words whole in farmer.ts, with no field keys (no HelpTip shows them)', () => {
		expect(FARMER_HELP.length).toBeGreaterThan(0);
		for (const e of FARMER_HELP) {
			expect(e.category, e.id).toBe('farmer');
			expect(e.fields, e.id).toBeUndefined();
		}
		expect(TIPS.filter((t) => t.category === 'farmer').map((t) => t.id)).toEqual([]);
		expect(HELP.filter((e) => e.category === 'farmer')).toEqual(FARMER_HELP);
	});

	it('joins tips and articles into whole entries for the glossary', () => {
		expect(HELP).toHaveLength(TIPS.length + FARMER_HELP.length);
		const dam = helpFor('node.damCapacityM3')!;
		expect(dam.term).toBe(tipFor('node.damCapacityM3')!.term);
		expect(dam.long).toBe(ARTICLES['dam-capacity']!.long);
	});

	it('has HelpTip load only the tips, never the glossary text', () => {
		const from = imports(read('../components/help/HelpTip.svelte')).map((i) => i.from);
		expect(from).toContain('$lib/help/tips');
		expect(from.filter((f) => /^\$lib\/help\/(content|articles|articles-data|farmer)\b/.test(f))).toEqual([]);
	});

	it('keeps the text modules free of run-time imports (their own chunks, loadable by Node)', () => {
		for (const f of ['./tips.ts', './articles.ts', './articles-data.ts', './farmer.ts', './types.ts']) {
			const src = read(f);
			expect(imports(src).filter((i) => !i.type), f).toEqual([]);
			expect(src, f).not.toMatch(/\bimport\s*\(/);
		}
	});
});

describe('helpFor', () => {
	it('finds entries by field key and by id', () => {
		expect(helpFor('node.damCapacityM3')?.id).toBe('dam-capacity');
		expect(helpFor('run.is_summer')?.id).toBe('legacy-runoff-model');
		expect(helpFor('calibration.a')).toBeUndefined();
		expect(helpFor('ewr')?.term).toMatch(/Environmental Water Requirement/);
		expect(helpFor('nope')).toBeUndefined();
	});
});

describe('searchHelp', () => {
	it('returns everything for an empty query', () => {
		expect(searchHelp('  ')).toHaveLength(HELP.length);
	});

	it('ranks term and alias matches first and needs every word', () => {
		expect(searchHelp('nse')[0]!.id).toBe('nse');
		expect(searchHelp('Reserve')[0]!.id).toBe('ewr'); // alias
		expect(searchHelp('kc')[0]!.id).toBe('crop-factor');
		expect(searchHelp('dam spill').map((e) => e.id)).toContain('spill');
		expect(searchHelp('zzzz')).toEqual([]);
	});

	it('ignores case and accents', () => {
		expect(searchHelp('NASH')[0]!.id).toBe('nse');
		expect(searchHelp('méan annual')[0]!.id).toBe('map');
	});
});
