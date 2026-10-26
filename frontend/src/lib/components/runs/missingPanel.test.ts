import type { RunSummary } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { missingPanel } from './missingPanel';
import { resultSections } from './sections';
import { modelQualitySections } from './modelQuality';

const bare = { farms: [] };
const full = {
	farms: [],
	runoff: { model: 'gr4j' } as RunSummary['runoff'],
	wr2012: {} as RunSummary['wr2012'],
	plausibility: { gauges: [{ nodeId: 'g' }] } as RunSummary['plausibility'],
	forecast: { from: '2026-10-01' } as RunSummary['forecast'],
	stations: { units: [{}], pairings: [] } as unknown as RunSummary['stations']
};
const OPTIONAL = ['res-forecast', 'res-gauges', 'res-runoff', 'res-unit-rain', 'res-wr2012', 'res-plausibility'];

describe('missingPanel', () => {
	it('says what each optional panel needs on a run without it, linking where it is set', () => {
		for (const id of OPTIONAL) {
			const m = missingPanel(id, bare);
			expect(m, id).not.toBeNull();
			expect(m!.text, id).toMatch(/^This run /);
		}
		expect(missingPanel('res-wr2012', bare)!.link).toEqual({ href: '?tab=settings#set-wr2012', label: 'WR2012 check' });
		expect(missingPanel('res-gauges', bare)!.link?.href).toBe('?tab=series');
		// Data feeds is on the Data page (issue #586), not Settings.
		expect(missingPanel('res-forecast', bare)!.link).toEqual({ href: '?tab=series#data-feeds', label: 'Data feeds' });
	});

	it('is null for a panel the run draws', () => {
		// The forecast on Runs & results, the rest in Model quality on Calibration (issue #586 Round 3).
		const drawn = [...resultSections(full, true), ...modelQualitySections(full)].map((s) => s.id);
		for (const id of OPTIONAL) {
			expect(drawn, id).toContain(id);
			expect(missingPanel(id, full), id).toBeNull();
		}
	});

	it('is null for a panel every run has, and for an unknown fragment (the page waits for it)', () => {
		for (const id of ['res-summary', 'res-notes', 'res-publication', 'res-explore', 'res-nothing']) expect(missingPanel(id, bare), id).toBeNull();
	});
});
