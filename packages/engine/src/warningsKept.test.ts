// settings.warningsKept (issue #611): the Warnings page's kept run warnings and problems, each with a note. The
// engine only normalises the list: it has no run effect.
import { describe, expect, it } from 'vitest';
import { resolveWarningsKept, WARNING_KEPT_ID } from './checkItems';
import { mergeSettings } from './prepare';

describe('resolveWarningsKept', () => {
	it('keeps well-formed entries once each, a missing note as empty, and warns of the rest', () => {
		const w: string[] = [];
		expect(
			resolveWarningsKept(
				[
					{ id: 'run:rain.zeroRun.missing:1a2b', note: 'Checked with the observer' },
					{ id: 'problem:data:s1' },
					{ id: 'run:rain.zeroRun.missing:1a2b', note: 'twice' },
					{ id: 'nope', note: '' },
					'run:x',
					null
				],
				w
			)
		).toEqual([
			{ id: 'run:rain.zeroRun.missing:1a2b', note: 'Checked with the observer' },
			{ id: 'problem:data:s1', note: '' }
		]);
		expect(w).toEqual(['kept warnings: an entry that isn’t one, or one listed twice, is ignored']);
		expect(resolveWarningsKept(null, [])).toBeNull();
		const w2: string[] = [];
		expect(resolveWarningsKept({}, w2)).toBeNull();
		expect(w2).toEqual(['kept warnings are not a list; ignored']);
		expect(WARNING_KEPT_ID.test('run:with space')).toBe(false);
	});

	it('is normalised by mergeSettings (the run itself is unchanged: run.flowMissing.test.ts)', () => {
		const kept = [{ id: 'run:rain.chirps.corrected:abc', note: 'fine' }];
		expect(mergeSettings({ warningsKept: kept }, []).warningsKept).toEqual(kept);
		expect('warningsKept' in mergeSettings({}, [])).toBe(false);
	});
});
