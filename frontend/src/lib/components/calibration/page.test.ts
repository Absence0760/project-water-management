import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RunSummary } from '@water-management/engine';
import { modelQualitySections } from '#lib/components/runs/modelQuality.js';
import { CALIBRATION_SETTINGS_ANCHORS, CALIBRATION_SETTINGS_SECTIONS } from '#lib/components/settings/sections.js';
import { anchorForward } from '#lib/nav/anchorMoves.js';
import { CAL_PARTS, CAL_SUBSECTIONS, calibrationNavGroups, calShown, isCalPart, isCalSubsection, shownRun } from './page';

const at = (href: string) => new URL(href, 'https://x.test');

describe('the side index (issue #586 round 3)', () => {
	const bare = { runoff: null, wr2012: null, plausibility: null, unitRain: null, stations: null } as unknown as RunSummary;
	const full = {
		runoff: { model: 'gr4j' } as RunSummary['runoff'],
		wr2012: { quaternary: 'Z99A' } as RunSummary['wr2012'],
		plausibility: { gauges: [{ nodeId: 'g' }] } as unknown as RunSummary['plausibility'],
		unitRain: null,
		stations: null
	} as unknown as RunSummary;
	const lines = (groups: ReturnType<typeof calibrationNavGroups>) => groups.map((g) => [g.label, g.sections.map((s) => s.label)]);

	it('names a group for each part by its heading, the settings panels under the first, by their headings', () => {
		expect(CAL_PARTS.map((p) => p.label)).toEqual(['Set up the fit', 'How the shown run fits']);
		expect(lines(calibrationNavGroups())).toEqual([
			['Set up the fit', ['Flow calibration', 'Calibration record', 'Fit the parameters', 'WR2012 check']],
			// No run shown yet: one line to the part, where its empty state is, under no second heading.
			[null, ['How the shown run fits']]
		]);
		expect(calibrationNavGroups()[0]!.sections.map((s) => s.id)).toEqual(CALIBRATION_SETTINGS_SECTIONS.map((s) => s.id));
		expect(calibrationNavGroups()[1]!.sections.map((s) => s.id)).toEqual(['cal-fit']);
		expect(isCalPart('cal-fit')).toBe(true);
		expect(isCalPart('set-fit')).toBe(false);
	});

	it('marks a part’s first line while its own heading is read, not the last line of the part above (a jump to #cal-fit)', () => {
		const [setup, fit] = calibrationNavGroups(bare);
		expect(setup!.sections[0]!.covers).toEqual(['cal-setup-h']);
		expect(fit!.sections[0]).toMatchObject({ id: 'res-hydrograph', covers: ['cal-fit-h'] });
		expect(fit!.sections.slice(1).every((s) => !s.covers)).toBe(true);
	});

	it('lists the shown run’s Model quality panels under the second, by their headings, with no shorter names', () => {
		expect(lines(calibrationNavGroups(bare))[1]).toEqual(['How the shown run fits', ['Hydrograph', 'Flow-duration curve', 'Calibration against observed flow', 'EWR test: model against observed flow']]);
		const results = calibrationNavGroups(full)[1]!.sections;
		expect(results.map((s) => s.id)).toEqual(modelQualitySections(full).map((s) => s.id));
		expect(results.map((s) => s.label)).toContain('WR2012 check: Z99A');
		for (const s of calibrationNavGroups(full).flatMap((g) => g.sections)) {
			// Only a part's own heading, under its first line (below).
			expect(s.covers ?? [], s.id).toEqual(s.covers ? [expect.stringMatching(/^cal-(setup|fit)-h$/)] : []);
		}
	});

	it('gives the sub-headings the page draws a line under Calibration against observed flow (D4)', () => {
		const ids = (shown: Parameters<typeof calibrationNavGroups>[1]) => calibrationNavGroups(bare, shown)[1]!.sections.map((s) => s.id);
		expect(ids({ check: true, provenance: true })).toEqual(['res-hydrograph', 'res-fdc', 'res-calibration', 'res-calibration-check', 'res-fit-provenance', 'res-ewr-agreement']);
		expect(ids({ provenance: true })).toEqual(['res-hydrograph', 'res-fdc', 'res-calibration', 'res-fit-provenance', 'res-ewr-agreement']);
		// Marked as sub-headings, so the rail indents them under their panel; the panels themselves are not.
		const sections = calibrationNavGroups(bare, { check: true, provenance: true })[1]!.sections;
		expect(sections.filter((s) => s.sub).map((s) => s.id)).toEqual(['res-calibration-check', 'res-fit-provenance']);
		expect(CAL_SUBSECTIONS.check.label).toBe('Calibration check: flow against use, per gauge');
		expect(CAL_SUBSECTIONS.provenance.label).toBe('Where the parameters came from');
		expect(isCalSubsection('res-fit-provenance')).toBe(true);
		expect(isCalSubsection('res-calibration')).toBe(false);
	});

	it('uses unique ids across both parts', () => {
		const ids = calibrationNavGroups(full, { check: true, provenance: true }).flatMap((g) => g.sections.map((s) => s.id));
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe('calShown: the sub-headings a run draws', () => {
	const outlet = [{ key: 'observed_flow', nodeId: null }, { key: 'simulated_flow', nodeId: null }];
	const inner = [{ key: 'observed_flow', nodeId: 'g1' }];
	it('draws the calibration check for an observed record at the outlet, and at an inner gauge only with the run’s network', () => {
		expect(calShown({ settings: {}, model: { nodes: [] } }, outlet)).toEqual({ check: true, provenance: true });
		expect(calShown({ settings: {}, model: { nodes: [] } }, inner).check).toBe(false);
		expect(calShown({ settings: {}, model: { nodes: [{}] } }, inner).check).toBe(true);
		expect(calShown({ settings: {}, model: null }, [{ key: 'simulated_flow', nodeId: null }]).check).toBe(false);
	});
	it('draws where the parameters came from only for a run that kept its settings', () => {
		expect(calShown({ settings: null }, outlet).provenance).toBe(false);
		expect(calShown({}, outlet).provenance).toBe(false);
	});
});

describe('shownRun', () => {
	const runs = [{ id: 'new' }, { id: 'mid', published: true }, { id: 'old' }];
	it('is the run picked while it is still a run, else the default', () => {
		expect(shownRun(runs, 'old', 'editor')?.id).toBe('old');
		expect(shownRun(runs, null, 'editor')?.id).toBe('new');
		expect(shownRun(runs, null, 'viewer')?.id).toBe('mid');
		expect(shownRun(runs, 'deleted', 'editor')?.id).toBe('new');
	});
	it('is null with no runs, or before they load', () => {
		expect(shownRun([], null, 'editor')).toBeNull();
		expect(shownRun(null, 'old', 'editor')).toBeNull();
	});
});

describe('old ?tab=calibration links (nav/anchorMoves.ts)', () => {
	it('sends an old ?tab=calibration#set-… link to a panel that stayed on Model settings there, every other parameter kept', () => {
		expect(anchorForward('calibration', at('/projects/p1?tab=calibration#set-ewr'))).toBe('/projects/p1?tab=settings#set-ewr');
		expect(anchorForward('calibration', at('/projects/p1?tab=calibration&rain=units#set%2Dfeeds'))).toBe('/projects/p1?tab=settings&rain=units#set-feeds');
	});
	it('leaves the page itself, its own parts and its settings panels alone (issue #586 round 3)', () => {
		expect(anchorForward('calibration', at('/projects/p1?tab=calibration'))).toBeNull();
		expect(anchorForward('calibration', at('/projects/p1?tab=calibration#cal-fit'))).toBeNull();
		expect(CALIBRATION_SETTINGS_ANCHORS).toEqual(['set-flow', 'set-record', 'set-fit', 'set-wr2012', 'set-evaporation', 'set-evaporation-station', 'set-prior']);
		for (const id of CALIBRATION_SETTINGS_ANCHORS) expect(anchorForward('calibration', at(`/projects/p1?tab=calibration#${id}`)), id).toBeNull();
		expect(anchorForward('calibration', at('/projects/p1?tab=calibration#%E0'))).toBeNull();
		for (const hash of ['#res-calibration', '#res-fit-provenance']) expect(anchorForward('calibration', at(`/projects/p1?tab=calibration${hash}`)), hash).toBeNull();
	});
});

/**
 * Every `#set-…` id the Calibration page draws: the settings form (settings/CalibrationSettings.svelte) and what it
 * imports, lazily or not, followed through the source. A block added under it with a `set-` id of its own and no
 * entry in CALIBRATION_SETTINGS_ANCHORS reads as a Model settings anchor to nav/anchorMoves.ts, which sends a link to
 * it away to Model settings (#646's Evaporation stations and #622's Regional prior, found by the e2e pins).
 */
function setIdsDrawnBy(entry: string): Map<string, string> {
	const lib = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
	const ids = new Map<string, string>();
	const seen = new Set<string>();
	// `uses`: for a barrel of re-exports (settings/lazySections.ts, shared with Model settings), only the names the
	// importing file reads from it; Model settings' own sections in it are not on this page.
	const visit = (file: string, uses: string | null = null) => {
		const src = readFileSync(file, 'utf8');
		const reexports = [...src.matchAll(/export \{ default as (\w+) \} from '([^']+)'/g)];
		if (reexports.length && uses !== null) {
			for (const [, name, spec] of reexports) if (new RegExp(`\\b${name}\\b`).test(uses)) follow(file, spec!, null);
			return;
		}
		if (seen.has(file)) return;
		seen.add(file);
		if (file.endsWith('.svelte')) for (const m of src.matchAll(/\bid="(set-[a-z0-9-]+)"/g)) ids.set(m[1]!, file.slice(lib.length + 1));
		for (const m of src.matchAll(/(?:from |import\()'((?:#lib\/|\.{1,2}\/)[^']+)'/g)) follow(file, m[1]!, src);
	};
	const follow = (from: string, spec: string, uses: string | null) => {
		const path = spec.startsWith('#lib/') ? resolve(lib, spec.slice(5)) : resolve(dirname(from), spec);
		const f = [path, path.replace(/\.js$/, '.ts'), `${path}.ts`, `${path}.svelte.ts`].find((c) => /\.(svelte|ts)$/.test(c) && existsSync(c));
		if (f) visit(f, uses);
	};
	visit(resolve(lib, entry));
	return ids;
}

describe('the Calibration page’s settings anchors', () => {
	it('lists every #set-… id the page draws, so a link to any of them stays on Calibration', () => {
		const drawn = setIdsDrawnBy('components/settings/CalibrationSettings.svelte');
		// Positive control: the walk reaches a lazy block (Evaporation from the map, through settings/lazySections.ts).
		expect(drawn.get('set-evaporation')).toBe('components/settings/EvaporationProposal.svelte');
		for (const [id, file] of drawn) expect(CALIBRATION_SETTINGS_ANCHORS, `${id} (${file})`).toContain(id);
		for (const id of CALIBRATION_SETTINGS_ANCHORS) expect([...drawn.keys()], id).toContain(id);
	});
});
