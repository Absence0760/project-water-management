import { describe, expect, it } from 'vitest';
import { runTags, tagKey, TAG_MEANINGS } from './runTags';

const run = { id: 'r1', legacy: false };
const ctx = { latestId: 'r1', publishedId: null, evidence: undefined };

describe('runTags (#586 D18)', () => {
	it('gives a row its tags in order, with the run’s own detail', () => {
		const tags = runTags(
			{ ...run, trigger: 'forecast', forecastFrom: '2022-01-29', pinned: true, citedBy: [{ kind: 'scenario', name: 'Raise' } as never], errata: ['E1', 'E2'] },
			{ ...ctx, publishedId: 'r1', evidence: 'past' }
		);
		expect(tags.map((t) => t.label)).toEqual(['latest', 'Forecast', 'Published', 'Former evidence', 'Pinned', 'Scenario base', 'May be affected']);
		expect(tags.find((t) => t.id === 'forecast')!.detail).toBe('Forecast days from 29 Jan 2022.');
		expect(tags.find((t) => t.id === 'scenarioBase')!.detail).toBe('The base of “Raise”.');
		expect(tags.find((t) => t.id === 'errata')!.detail).toBe('2 known engine bugs: E1, E2.');
	});
	it('keys each tag a shown row carries once, in the meanings’ order', () => {
		const rows = [runTags({ ...run, pinned: true }, ctx), runTags({ ...run, id: 'r2', pinned: true, trigger: 'auto' }, ctx)];
		expect(tagKey(rows)).toEqual([
			{ label: 'latest', meaning: TAG_MEANINGS.latest },
			{ label: 'Auto', meaning: TAG_MEANINGS.auto },
			{ label: 'Pinned', meaning: TAG_MEANINGS.pinned }
		]);
		expect(tagKey([[]])).toEqual([]);
	});
});
