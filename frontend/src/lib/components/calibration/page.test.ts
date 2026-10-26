import { describe, expect, it } from 'vitest';
import type { RunSummary } from '@water-management/engine';
import { modelQualitySections } from '#lib/components/runs/modelQuality.js';
import { CALIBRATION_SETTINGS_ANCHORS, CALIBRATION_SETTINGS_SECTIONS } from '#lib/components/settings/sections.js';
import { anchorForward } from '#lib/nav/anchorMoves.js';
import { CAL_PARTS, CAL_SUBSECTIONS, calibrationNavGroups, isCalPart, isCalSubsection, shownRun } from './page';

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
			// No run shown yet: the group draws nothing.
			['How the shown run fits', []]
		]);
		expect(calibrationNavGroups()[0]!.sections.map((s) => s.id)).toEqual(CALIBRATION_SETTINGS_SECTIONS.map((s) => s.id));
		expect(isCalPart('cal-fit')).toBe(true);
		expect(isCalPart('set-fit')).toBe(false);
	});

	it('lists the shown run’s Model quality panels under the second, by their headings, with no shorter names', () => {
		expect(lines(calibrationNavGroups(bare))[1]).toEqual(['How the shown run fits', ['Hydrograph', 'Flow-duration curve', 'Calibration against observed flow', 'EWR test: model against observed flow']]);
		const results = calibrationNavGroups(full)[1]!.sections;
		expect(results.map((s) => s.id)).toEqual(modelQualitySections(full).map((s) => s.id));
		expect(results.map((s) => s.label)).toContain('WR2012 check: Z99A');
		for (const s of calibrationNavGroups(full).flatMap((g) => g.sections)) {
			expect(s.bar, s.id).toBeUndefined();
			expect(s.covers, s.id).toBeUndefined();
		}
	});

	it('gives the sub-headings the page draws a line under Calibration against observed flow (D4)', () => {
		const ids = (shown: Parameters<typeof calibrationNavGroups>[1]) => calibrationNavGroups(bare, shown)[1]!.sections.map((s) => s.id);
		expect(ids({ check: true, provenance: true })).toEqual(['res-hydrograph', 'res-fdc', 'res-calibration', 'res-calibration-check', 'res-fit-provenance', 'res-ewr-agreement']);
		expect(ids({ provenance: true })).toEqual(['res-hydrograph', 'res-fdc', 'res-calibration', 'res-fit-provenance', 'res-ewr-agreement']);
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
		expect(CALIBRATION_SETTINGS_ANCHORS).toEqual(['set-flow', 'set-record', 'set-fit', 'set-wr2012', 'set-evaporation']);
		for (const id of CALIBRATION_SETTINGS_ANCHORS) expect(anchorForward('calibration', at(`/projects/p1?tab=calibration#${id}`)), id).toBeNull();
		expect(anchorForward('calibration', at('/projects/p1?tab=calibration#%E0'))).toBeNull();
		for (const hash of ['#res-calibration', '#res-fit-provenance']) expect(anchorForward('calibration', at(`/projects/p1?tab=calibration${hash}`)), hash).toBeNull();
	});
});
