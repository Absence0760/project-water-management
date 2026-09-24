import {
	defaultProjectSettings,
	SERIES_KINDS,
	type CalibrationStats,
	type CropArea,
	type CropDef,
	type FarmSummary,
	type NetworkNode,
	type RunSummary,
	type Transfer
} from '@water-management/engine';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CATEGORY_TITLES, HELP, helpFieldKeys, helpFor, searchHelp } from './content';

// Exhaustive `Record<keyof T, true>` objects: the typecheck fails if the engine
// renames a field, so help keys can't silently drift from the model.
const NODE: Record<keyof NetworkNode, true> = {
	id: true, name: true, kind: true, downstreamNodeId: true, sortOrder: true, areaKm2: true, areaHiKm2: true,
	areaLoKm2: true, flowShareManual: true, pctUpstreamToDam: true, pctRunoffToDam: true, damCapacityM3: true,
	damInitialPct: true, damMinPct: true, divertCapacityM3Day: true, returnFlowPct: true
};
const CROP: Record<keyof CropDef, true> = { id: true, name: true, sortOrder: true, cropFactor: true };
const CROP_AREA: Record<keyof CropArea, true> = { nodeId: true, cropId: true, areaM2: true };
const TRANSFER: Record<keyof Transfer, true> = {
	id: true, fromNodeId: true, toNodeId: true, months: true, maxRateM3s: true, dailyCapM3: true, minStoragePct: true, enabled: true
};
const SUMMARY: Record<keyof FarmSummary, true> = {
	nodeId: true, name: true, avgDemandM3Day: true, avgSuppliedM3Day: true, avgDeficitM3Day: true,
	fractionSupplied: true, avgEwrShortfallM3Day: true, daysEwrNotMet: true
};
const CATCHMENT: Record<keyof RunSummary['catchment'], true> = {
	meanNaturalFlowM3Day: true, meanSimulatedOutflowM3Day: true, runoffCoefficient: true, ewrDaysNotMet: true,
	ewrFractionDaysNotMet: true, ewrAgreement: true
};
const STATS: Record<keyof CalibrationStats, true> = {
	days: true, nse: true, pbias: true, rmseM3s: true, meanObservedM3s: true, meanSimulatedM3s: true,
	windowStart: true, windowEnd: true, firstObservedDate: true, lastObservedDate: true, kge: true, kgeR: true,
	kgeAlpha: true, kgeBeta: true, r2: true, logNse: true, logEpsilonM3s: true, volumeErrorPct: true,
	annualVolumes: true, flowKind: true, simulatedKey: true, exclusions: true, excludedDays: true
};
// Run series keys emitted by packages/engine/src/run.ts and flow.ts.
const RUN_KEYS = [
	'natural_flow', 'simulated_outflow', 'observed_flow', 'ewr', 'ewr_shortfall', 'rain_used', 'is_summer', 'rain_flow',
	'base_flow', 'response_flow', 'resultant_flow', 'rain_final', 'rain_chirps', 'rain_chirps_corrected', 'chirps_factor', 'rain_catchment_missing', 'demand', 'supplied', 'deficit', 'inflow_upstream', 'runoff',
	'transfer', 'dam_storage', 'spill', 'outflow', 'ewr_cumulative', 'ewr_shortfall_incremental',
	// Farm working columns (engine 0.12.0, packages/engine/src/verify/columns.ts)
	'gross_demand', 'effective_rain', 'soil_water', 'upstream_to_dam', 'upstream_below_dam', 'runoff_to_dam', 'runoff_below_dam',
	'diverted_to_dam', 'interim_storage', 'below_dam_not_diverted', 'return_flow', 'balance_residual',
	// GR4J (packages/engine/src/runoff/simulate.ts)
	'pet', 'aet', 'production_store', 'routing_store', 'uh_store', 'exchange'
];

const settings = defaultProjectSettings();
const VALID: Record<string, Set<string>> = {
	node: new Set(Object.keys(NODE)),
	crop: new Set(Object.keys(CROP)),
	cropArea: new Set(Object.keys(CROP_AREA)),
	transfer: new Set(Object.keys(TRANSFER)),
	settings: new Set(Object.keys(settings)),
	calibration: new Set(Object.keys(settings.calibration)),
	series: new Set(SERIES_KINDS),
	summary: new Set(Object.keys(SUMMARY)),
	catchment: new Set(Object.keys(CATCHMENT)),
	stats: new Set(Object.keys(STATS)),
	run: new Set(RUN_KEYS)
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
			...SERIES_KINDS.map((k) => `series.${k}`)
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
			// Components that place the HelpTip themselves take the key as a helpKey prop (PeriodList).
			for (const m of src.matchAll(/\bhelpKey=["']([^"']+)["']/g)) used.push(m[1]!);
		}
		for (const k of used) expect(helpFor(k), `HelpTip key "${k}"`).toBeDefined();
	});
});

describe('helpFor', () => {
	it('finds entries by field key and by id', () => {
		expect(helpFor('node.damCapacityM3')?.id).toBe('dam-capacity');
		expect(helpFor('calibration.a')?.id).toBe('peak-coefficient');
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
