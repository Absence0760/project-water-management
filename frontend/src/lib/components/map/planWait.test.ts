import { describe, expect, it } from 'vitest';
import type { PlanRequest } from '#lib/api/types.js';
import { isPlanWaiting, planOutcomeText, planWaitingText } from './planWait';

// The words the Start and Divide sheets show for a plan the background worker routes (#646 item 3, 272_plan_request).
const request = (over: Partial<PlanRequest> = {}): PlanRequest => ({
	id: 'r',
	kind: 'start',
	status: 'queued',
	progress: null,
	error: null,
	proposal: null,
	fallbackId: 'p',
	refusal: null,
	createdAt: '2026-10-28T10:00:00.000Z',
	finishedAt: null,
	...over
});

describe('a plan on the worker', () => {
	it('waits while queued or running, and not once it has an outcome', () => {
		expect(['queued', 'running'].map((status) => isPlanWaiting(request({ status: status as PlanRequest['status'] })))).toEqual([true, true]);
		expect(['proposed', 'refused', 'failed', 'superseded'].map((status) => isPlanWaiting(request({ status: status as PlanRequest['status'] })))).toEqual([false, false, false, false]);
		expect(isPlanWaiting(null)).toBe(false);
	});

	it('says a Start’s proposal without the order is there meanwhile, and that it is what you get with no worker', () => {
		const t = planWaitingText(request());
		expect(t).toMatch(/^Queued for the background: the catchment is too large to route within a request\. The proposal below has each unit’s boundary and area but no order yet/);
		expect(t).toMatch(/With no background worker running, this one is what you get\.$/);
		expect(planWaitingText(request({ status: 'running', progress: 42.4 }))).toMatch(/^Routing it in the background \(42 % through\)/);
		expect(planWaitingText(request({ kind: 'divide', fallbackId: null }))).toBe('Queued for the background: the catchment is too large to route within a request. The division is proposed when it is done, a minute or two.');
	});

	it('words a refusal or a failure, and says nothing for a routed proposal or a superseded request', () => {
		expect(planOutcomeText(request({ status: 'refused', refusal: { reason: 'too_large', message: 'Too large even here.' } }))).toBe('The background routing couldn’t order the units: Too large even here. The proposal without the order stands.');
		expect(planOutcomeText(request({ kind: 'divide', status: 'refused', refusal: { reason: 'map_changed', message: 'A point is gone.' } }))).toBe('A point is gone.');
		expect(planOutcomeText(request({ status: 'failed', error: 'The elevation model could not be read just now.' }))).toBe(
			'The background routing failed: The elevation model could not be read just now. The proposal without the order stands; propose again to try once more.'
		);
		expect(planOutcomeText(request({ kind: 'divide', status: 'failed', error: 'cancelled' }))).toBe('The background routing failed. Propose again to try once more.');
		expect(planOutcomeText(request({ status: 'proposed' }))).toBeNull();
		expect(planOutcomeText(request({ status: 'superseded' }))).toBeNull();
	});
});
