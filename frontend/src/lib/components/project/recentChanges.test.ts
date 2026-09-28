import { describe, expect, it } from 'vitest';
import type { HistoryRevision } from '$lib/api/types';
import { recentChange } from './recentChanges';

const rev = (over: Partial<HistoryRevision>): HistoryRevision => ({
	type: 'revision',
	id: '1',
	createdAt: '2026-09-26T12:30:00.000000Z',
	changeSet: null,
	actor: 'Ann',
	source: 'model_put',
	reason: null,
	changes: [],
	restoredFrom: null,
	restoredFromRun: null,
	...over
});
const line = (text: string) => ({ area: 'network' as const, kind: 'changed' as const, subject: 'Rooikloof', text });

describe('recentChange', () => {
	it('gives the heading, the first line and how many more', () => {
		const r = rev({ changes: [line('Rooikloof: dam capacity 1 m³ → 2 m³'), line('Rooikloof: area 1 km² → 2 km²'), line('Rooikloof: x')] });
		expect(recentChange(r)).toEqual({ title: 'Model changed', first: 'Rooikloof: dam capacity 1 m³ → 2 m³', more: 2 });
	});

	it('uses the History tab’s wording for a revision without lines', () => {
		expect(recentChange(rev({ source: 'settings_patch' }))).toEqual({
			title: 'Settings changed',
			first: 'Order or detail changes that the change list doesn’t describe.',
			more: 0
		});
	});
});
