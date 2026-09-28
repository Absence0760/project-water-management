import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VerificationCheck } from '@water-management/engine';
import { DEFAULT_RUNS_KEPT, logSelfCheckFailure, runsKeptPerProject, seriesHash } from './execute.js';

describe('runsKeptPerProject', () => {
	it('reads RUNS_KEPT_PER_PROJECT and falls back to the default for anything invalid', () => {
		expect(DEFAULT_RUNS_KEPT).toBe(20);
		expect(runsKeptPerProject(undefined)).toBe(20);
		expect(runsKeptPerProject('5')).toBe(5);
		expect(runsKeptPerProject(' 7 ')).toBe(7);
		for (const bad of ['', '  ', '0', '-3', '2.5', 'ten', 'Infinity']) expect(runsKeptPerProject(bad)).toBe(20);
	});
});

describe('seriesHash', () => {
	it('is a stable SHA-256 hex that changes with any value, including a missing day', () => {
		const h = seriesHash([1, 2.5, null]);
		expect(h).toMatch(/^[0-9a-f]{64}$/);
		expect(seriesHash([1, 2.5, null])).toBe(h);
		expect(seriesHash([1, 2.5, 0])).not.toBe(h);
		expect(seriesHash([1, 2.5])).not.toBe(h);
	});
});

// A check id/label pair only — never a detail string, since detail can name a
// farm and a date (humanized in verify/verify.ts), which this event must not carry.
const check = (id: VerificationCheck['id'], passed: boolean): VerificationCheck => ({
	id,
	label: `checks that ${id}`,
	passed,
	detail: passed ? null : `the check could not run: ${id} broke on "Client Farm Name" on 2024-01-02`
});

describe('logSelfCheckFailure', () => {
	afterEach(() => vi.restoreAllMocks());

	it('logs exactly one structured line naming only the failed check ids when a run fails its self-checks', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const verification = { passed: false, checks: [check('balance', true), check('ewrAttribution', false), check('workings', false)], maxResidual: null };
		logSelfCheckFailure('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', { summary: { verification } });

		expect(error).toHaveBeenCalledOnce();
		const line = error.mock.calls[0]![0] as string;
		expect(JSON.parse(line)).toEqual({
			event: 'self_check_failed',
			projectId: '11111111-1111-1111-1111-111111111111',
			runId: '22222222-2222-2222-2222-222222222222',
			checks: ['ewrAttribution', 'workings']
		});
		// No farm name, date or other client-identifying value leaked from `detail`.
		expect(line).not.toContain('Client Farm Name');
		expect(line).not.toContain('2024-01-02');
	});

	it('logs nothing for a run that passes every self-check', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const verification = { passed: true, checks: [check('balance', true), check('workings', true)], maxResidual: null };
		logSelfCheckFailure('proj', 'run', { summary: { verification } });
		expect(error).not.toHaveBeenCalled();
	});

	it('logs nothing for a run saved by an engine too old to carry verification', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		logSelfCheckFailure('proj', 'run', { summary: {} });
		expect(error).not.toHaveBeenCalled();
	});
});
