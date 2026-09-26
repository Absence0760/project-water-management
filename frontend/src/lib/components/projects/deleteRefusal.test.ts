import { describe, expect, it } from 'vitest';
import { ApiError } from '$lib/api/client';
import { evidenceRefusal } from './deleteRefusal';

describe('evidenceRefusal', () => {
	it('reads the evidence run and the history length from a 409', () => {
		const err = new ApiError(409, "this project can't be deleted: …", { evidenceRun: { id: 'r1', label: 'Calibrated GR4J' }, nominations: 2 });
		expect(evidenceRefusal(err)).toEqual({ run: { id: 'r1', label: 'Calibrated GR4J' }, nominations: 2 });
	});

	it('still recognises the refusal when the server could not name the run', () => {
		expect(evidenceRefusal(new ApiError(409, 'x', { evidenceRun: null, nominations: null }))).toEqual({ run: null, nominations: null });
	});

	it('ignores any other error: another status, another 409, a plain Error', () => {
		expect(evidenceRefusal(new ApiError(403, 'forbidden', { evidenceRun: { id: 'r1', label: 'x' } }))).toBeNull();
		expect(evidenceRefusal(new ApiError(409, 'violates a data rule'))).toBeNull();
		expect(evidenceRefusal(new ApiError(409, 'x', [{ message: 'zod issue' }]))).toBeNull();
		expect(evidenceRefusal(new Error('network'))).toBeNull();
	});

	it('drops a malformed run rather than trusting it', () => {
		expect(evidenceRefusal(new ApiError(409, 'x', { evidenceRun: { id: 7 }, nominations: 'two' }))).toEqual({ run: null, nominations: null });
	});
});
