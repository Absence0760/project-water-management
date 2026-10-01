import { describe, expect, it } from 'vitest';
import { parseStartMessage } from './messages';

describe('parseStartMessage', () => {
	const request = { apiBase: '/api', projectId: 'p1', runId: 'r1' };

	it('accepts the run workbook request and the farm audit request', () => {
		expect(parseStartMessage({ type: 'start', request })).toEqual({ type: 'start', request });
		expect(parseStartMessage({ type: 'start', request: { ...request, auditNodeId: 'n1' } })).toEqual({
			type: 'start',
			request: { ...request, auditNodeId: 'n1' }
		});
	});

	it('copies only the known fields', () => {
		const msg = parseStartMessage({ type: 'start', request });
		expect(msg?.request).not.toBe(request);
		expect(Object.keys(msg!.request)).toEqual(['apiBase', 'projectId', 'runId']);
	});

	it.each([
		['null', null],
		['a string', 'start'],
		['an array', [{ type: 'start', request }]],
		['another type', { type: 'cancel', request }],
		['an extra message field', { type: 'start', request, extra: 1 }],
		['no request', { type: 'start' }],
		['a request that is not an object', { type: 'start', request: 'p1/r1' }],
		['an extra request field', { type: 'start', request: { ...request, url: 'https://elsewhere.test' } }],
		['a non-string apiBase', { type: 'start', request: { ...request, apiBase: 1 } }],
		['an empty projectId', { type: 'start', request: { ...request, projectId: '' } }],
		['a missing runId', { type: 'start', request: { apiBase: '/api', projectId: 'p1' } }],
		['an empty auditNodeId', { type: 'start', request: { ...request, auditNodeId: '' } }],
		['a non-string auditNodeId', { type: 'start', request: { ...request, auditNodeId: 7 } }]
	])('refuses %s', (_, data) => {
		expect(parseStartMessage(data)).toBeNull();
	});
});
