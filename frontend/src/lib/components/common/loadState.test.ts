// followRetry's decision (loadState.ts retryStep, issue #586 R4-I): after each change in the watched
// scope, where a hand-built Try again's focus goes. The DOM side is guarded by
// e2e/tests/586-a11y-retry-focus.spec.ts.
import { describe, expect, it } from 'vitest';
import { retryStep, type RetryView } from './loadState';

const view = (v: Partial<RetryView>): RetryView => ({ moved: false, again: false, pressedOn: false, loading: false, ...v });

describe('retryStep', () => {
	it('lets go once the reader has moved the focus, whatever is drawn', () => {
		expect(retryStep(view({ moved: true, again: true, loading: true, pressedOn: true }))).toBe('stop');
	});
	it('goes to a new Try again when the retry failed again', () => {
		expect(retryStep(view({ again: true }))).toBe('again');
		expect(retryStep(view({ again: true, loading: true }))).toBe('again');
	});
	it('waits while the pressed Try again is still on the page: the focus is still on it', () => {
		expect(retryStep(view({ pressedOn: true }))).toBe('wait');
		expect(retryStep(view({ pressedOn: true, loading: true }))).toBe('wait');
	});
	it('goes to the loading line while the retry loads', () => {
		expect(retryStep(view({ loading: true }))).toBe('loading');
	});
	it('lands on the heading once nothing is loading and nothing failed', () => {
		expect(retryStep(view({}))).toBe('landing');
	});
});
