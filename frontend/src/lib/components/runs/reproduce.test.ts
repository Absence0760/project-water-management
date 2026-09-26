import { describe, expect, it } from 'vitest';
import type { Reproduction } from '$lib/api';
import { differenceText, reproductionHeadline } from './reproduce';

const names = (id: string) => (id === 'n1' ? 'Upper farm' : undefined);
const base: Reproduction = { status: 'identical', identical: true, engineVersionThen: '0.31.1', engineVersionNow: '0.31.1', differences: [], truncated: 0 };

describe('differenceText', () => {
	it('names the value and how it differs', () => {
		expect(differenceText({ kind: 'summary', path: 'farms[0].deficitDays' }, names)).toBe('Summary value farms[0].deficitDays');
		expect(differenceText({ kind: 'series', key: 'dam_storage', nodeId: 'n1', label: 'Dam storage', days: 3, firstDate: '2020-02-01', maxAbsDiff: 12.5 }, names)).toBe(
			'Upper farm: Dam storage differs on 3 days from 2020-02-01, by up to 12.50'
		);
		expect(differenceText({ kind: 'series', key: 'q', nodeId: null, label: 'Outflow', days: 1, firstDate: '2020-02-01', maxAbsDiff: 2e-9 }, names)).toBe(
			'Catchment: Outflow differs on 1 day from 2020-02-01, by up to 2.00e-9'
		);
		expect(differenceText({ kind: 'series', key: 'q', nodeId: 'gone', label: 'Outflow', days: 2, firstDate: '2020-02-01', maxAbsDiff: null }, names)).toBe(
			'a node: Outflow differs on 2 days from 2020-02-01'
		);
		expect(differenceText({ kind: 'series_missing', key: 'q', nodeId: null, label: 'Q' }, names)).toBe('Catchment: Q is stored with the run but not produced now');
		expect(differenceText({ kind: 'series_extra', key: 'q', nodeId: 'n1', label: 'Q' }, names)).toBe("Upper farm: Q is produced now but wasn't stored with the run");
	});
});

describe('reproductionHeadline', () => {
	it('is good news only when identical', () => {
		expect(reproductionHeadline(base)).toEqual({ text: 'Identical: re-run from its stored inputs, every result and daily output matches (engine 0.31.1).', tone: 'ok' });
	});

	it('treats a difference on the same engine as an error, and on a newer engine as expected', () => {
		const diff = { ...base, status: 'differs' as const, identical: false, differences: [{ kind: 'summary' as const, path: 'a' }], truncated: 4 };
		expect(reproductionHeadline(diff)).toMatchObject({ tone: 'error', text: expect.stringMatching(/^Differs in 5 places \(engine 0\.31\.1\)\. The engine is the same version/) });
		expect(reproductionHeadline({ ...diff, engineVersionThen: '0.30.0' })).toMatchObject({
			tone: 'warn',
			text: expect.stringMatching(/^Differs in 5 places \(engine 0\.30\.0 then, 0\.31\.1 now\)\. The engine has changed/)
		});
	});

	it('passes on why a run can’t be re-run', () => {
		expect(reproductionHeadline({ ...base, status: 'not_reproducible', identical: false, message: 'made before 021' }).text).toBe('Not reproducible: made before 021');
		expect(reproductionHeadline({ ...base, status: 'inconsistent', identical: false, message: 'fails its SHA-256 check' })).toMatchObject({ tone: 'error' });
		expect(reproductionHeadline({ ...base, status: 'failed', identical: false, message: 'refuses' }).text).toBe('refuses');
	});
});
