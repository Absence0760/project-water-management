// The season decision log's subjects (issue #119, decision.ts). The database
// round trip (what publishing records, that it outlives the run, who reads it)
// is in publication.db.test.ts.
import type { FarmProjection } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { decisionFarm, noticeChangedSubject, publishedSubject, withoutFarmFigures } from './decision.js';
import type { Publication } from './publish.js';

const publication = {
	id: 'p1',
	runId: 'r1',
	publishedAt: '2024-01-02T08:00:00.000Z',
	publishedBy: 'Ann',
	note: 'Dry spell',
	restriction: { level: 'restricted', pct: 20, notice: { en: 'Irrigate at night only.', af: 'Besproei net snags.' } },
	nextExpectedOn: '2024-01-15',
	catchmentView: {
		runStart: '2021-10-01',
		dataUntil: '2023-12-29',
		season: { from: '2023-10-01', to: '2023-12-29', days: 90 },
		last30: { from: '2023-11-30', to: '2023-12-29', days: 30 },
		runDays: 820,
		farmCount: 1,
		sites: [],
		engineVersion: '1.55.0',
		runoffModel: 'gr4j',
		calibration: null
	},
	supersededAt: null,
	updatedAt: null,
	updatedBy: null
} as Publication;

const view = {
	nodeId: 'n1',
	name: 'Hilltop',
	dataUntil: '2023-12-29',
	season: { from: '2023-10-01', to: '2023-12-29', demandM3: 1000, suppliedM3: 900, fraction: 0.9, shortDays: 3, shortMonths: ['2023-11'], shortDaysAtStopLevel: 1 },
	dam: { pct: 0.5 },
	river: { headline: 0.85, band: 'watch', equitableFraction: 0.7, aboveBelowShareM3Day: 2 }
} as unknown as FarmProjection;

describe('the decision log subjects', () => {
	it('takes a farm’s own figures only, never the even share', () => {
		const f = decisionFarm(view);
		expect(f).toEqual({
			nodeId: 'n1',
			name: 'Hilltop',
			dataUntil: '2023-12-29',
			season: { from: '2023-10-01', to: '2023-12-29', demandM3: 1000, suppliedM3: 900, fraction: 0.9, shortDays: 3 },
			damPct: 0.5,
			model: { headline: 0.85, band: 'watch' }
		});
		expect(JSON.stringify(f)).not.toMatch(/equitable|aboveBelow/);
		expect(decisionFarm({ ...view, dam: null }).damPct).toBeNull();
	});

	it('records the notice, window, run and figures of a publication, and `auto` only when it was', () => {
		const s = publishedSubject(publication, { inputsSha256: 'h', views: [view] });
		expect(s).toEqual({
			publicationId: 'p1',
			runId: 'r1',
			engineVersion: '1.55.0',
			runoffModel: 'gr4j',
			inputsSha256: 'h',
			window: { runStart: '2021-10-01', dataUntil: '2023-12-29', season: { from: '2023-10-01', to: '2023-12-29' }, last30: { from: '2023-11-30', to: '2023-12-29' } },
			restriction: { level: 'restricted', pct: 20, notice: { en: 'Irrigate at night only.', af: 'Besproei net snags.' } },
			nextExpectedOn: '2024-01-15',
			note: 'Dry spell',
			farms: 1,
			perFarm: [decisionFarm(view)]
		});
		expect(publishedSubject(publication, { inputsSha256: 'h', views: [], auto: true })).toMatchObject({ farms: 0, perFarm: [], auto: true });
	});

	it('records the whole notice after a change, with the fields sent', () => {
		expect(noticeChangedSubject(publication, ['note'])).toEqual({
			publicationId: 'p1',
			runId: 'r1',
			fields: ['note'],
			restriction: publication.restriction,
			nextExpectedOn: '2024-01-15',
			note: 'Dry spell'
		});
	});

	it('leaves the per-farm figures out of an exported event, and anything else alone', () => {
		const ev = { id: 1, kind: 'publication.published', subject: { farms: 1, perFarm: [decisionFarm(view)], note: 'x' } };
		expect(withoutFarmFigures(ev)).toEqual({ id: 1, kind: 'publication.published', subject: { farms: 1, note: 'x' } });
		expect(ev.subject.perFarm).toHaveLength(1);
		const other = { id: 2, kind: 'invite.sent', subject: { email: 'j•••@example.com' } };
		expect(withoutFarmFigures(other)).toBe(other);
		expect(withoutFarmFigures(null)).toBeNull();
	});
});
