import { describe, expect, it } from 'vitest';
import type { RunSummary } from '@water-management/engine';
import { resultSections } from '#lib/components/runs/sections.js';
import { SETTINGS_SECTIONS } from '#lib/components/settings/sections.js';
import { anchorForward } from '#lib/nav/anchorMoves.js';
import { CAL_PARTS, calibrationNavGroups, isCalPart, RESULT_LINKS, runsHref, settingsHref, SETUP_LINKS, shownRun } from './page';

const at = (href: string) => new URL(href, 'https://x.test');

describe('the side index', () => {
	it('lists the two parts by their headings, and nothing else', () => {
		expect(calibrationNavGroups()).toEqual([{ label: null, sections: [...CAL_PARTS] }]);
		expect(CAL_PARTS.map((p) => p.label)).toEqual(['Set up the fit', 'How the shown run fits']);
		expect(isCalPart('cal-fit')).toBe(true);
		expect(isCalPart('set-fit')).toBe(false);
	});
});

describe('the links to where the panels are today', () => {
	it('names the four calibration panels on Settings by their headings, in its order', () => {
		expect(SETUP_LINKS.map((l) => [l.id, l.label])).toEqual([
			['set-flow', 'Flow calibration'],
			['set-record', 'Calibration record'],
			['set-fit', 'Fit the parameters'],
			['set-wr2012', 'WR2012 check']
		]);
		for (const l of SETUP_LINKS) expect(SETTINGS_SECTIONS.find((s) => s.id === l.id)?.label).toBe(l.label);
		expect(settingsHref('set-fit')).toBe('?tab=settings#set-fit');
	});

	it('names the Model quality panels every run has by the headings Runs & results gives them, in its order', () => {
		// A run with none of the optional panels: what's listed is on every run's page.
		const bare = { farms: [], runoff: null, wr2012: null, plausibility: null, forecast: null, unitRain: null, stations: null } as unknown as RunSummary;
		const rail = resultSections(bare, true);
		const order = rail.map((s) => s.id);
		for (const l of RESULT_LINKS) expect(rail.find((s) => s.id === l.id)?.label, l.id).toBe(l.label);
		expect(RESULT_LINKS.map((l) => order.indexOf(l.id))).toEqual([...RESULT_LINKS.map((l) => order.indexOf(l.id))].sort((a, b) => a - b));
	});

	it('keeps the picked run on a link to Runs & results', () => {
		expect(runsHref('res-hydrograph', null)).toBe('?tab=runs#res-hydrograph');
		expect(runsHref('res-fdc', 'r 1')).toBe('?tab=runs&run=r%201#res-fdc');
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
	it('sends an old ?tab=calibration#set-… link on to that panel on Settings, every other parameter kept', () => {
		expect(anchorForward('calibration', at('/projects/p1?tab=calibration#set-ewr'))).toBe('/projects/p1?tab=settings#set-ewr');
		expect(anchorForward('calibration', at('/projects/p1?tab=calibration&rain=units#set%2Dfeeds'))).toBe('/projects/p1?tab=settings&rain=units#set-feeds');
	});
	it('leaves the page itself and its own parts alone', () => {
		expect(anchorForward('calibration', at('/projects/p1?tab=calibration'))).toBeNull();
		expect(anchorForward('calibration', at('/projects/p1?tab=calibration#cal-fit'))).toBeNull();
		expect(anchorForward('calibration', at('/projects/p1?tab=calibration#%E0'))).toBeNull();
	});
});
