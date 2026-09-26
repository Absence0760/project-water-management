import { describe, expect, it } from 'vitest';
import { ApiError } from '$lib/api/client';
import { classify, farmHref, pickNode } from './load';

describe('what a failed request means', () => {
	it('403 and 404 mean access removed; 0 means no signal; the rest a failure', () => {
		expect(classify(new ApiError(403, 'x'))).toBe('removed');
		expect(classify(new ApiError(404, 'x'))).toBe('removed');
		expect(classify(new ApiError(0, 'x'))).toBe('offline');
		expect(classify(new ApiError(500, 'x'))).toBe('failed');
		expect(classify(new ApiError(401, 'x'))).toBe('failed');
		expect(classify(new Error('boom'))).toBe('failed');
		expect(classify(null)).toBe('failed');
	});
});

describe('which farm to show', () => {
	const index = { farms: [{ nodeId: 'a', name: 'A' }, { nodeId: 'b', name: 'B' }] };
	it('takes ?node= only when it is one of the user’s farms', () => {
		expect(pickNode(index, 'b')).toBe('b');
		expect(pickNode(index, 'zzz')).toBeNull();
	});
	it('otherwise the farm shown last on this phone, then the first', () => {
		expect(pickNode(index, null, 'b')).toBe('b');
		expect(pickNode(index, null, 'gone')).toBe('a');
		expect(pickNode(index, null)).toBe('a');
		expect(pickNode({ farms: [] }, null)).toBeNull();
	});
	it('links with ?node= only when there are several farms', () => {
		expect(farmHref('', 'p 1', 'n/1', true, 'why')).toBe('/farm/p%201/why?node=n%2F1');
		expect(farmHref('/base', 'p', 'n', false)).toBe('/base/farm/p');
	});
});
