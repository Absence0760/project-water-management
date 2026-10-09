import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiKey } from '$lib/api/types';
import { SERIES_KINDS, unitOptions } from '@water-management/engine';
import { apiBase, curlExample, INGEST_EXAMPLE_BODY, keyRow, keyState, revokeKeyQuestion, sortKeys } from './apiKeys';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const key = (over: Partial<ApiKey> = {}): ApiKey => ({
	id: 'k1',
	name: 'Weir gateway',
	prefix: '3f2a9c1e',
	scopes: ['series:write'],
	allowedSeries: null,
	createdAt: '2026-09-01T08:00:00Z',
	createdBy: 'Jo Owner',
	lastUsedAt: null,
	expiresAt: null,
	revokedAt: null,
	revokedBy: null,
	...over
});

// Dates are in the viewer's own zone; run under a skewed one unless a test picks its own.
const tz = process.env.TZ;
beforeEach(() => {
	process.env.TZ = 'Africa/Johannesburg';
});
afterEach(() => {
	process.env.TZ = tz;
});

describe('a key’s state', () => {
	it('ends at the same instant whatever the viewer’s zone', () => {
		const k = key({ expiresAt: '2026-09-26T12:00:00Z' });
		for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC']) {
			process.env.TZ = zone;
			expect(keyState(k, NOW - 1), zone).toBe('live');
			expect(keyState(k, NOW), zone).toBe('expired');
		}
	});

	it('shows the made date in the viewer’s own zone', () => {
		process.env.TZ = 'Pacific/Pago_Pago';
		expect(keyRow(key(), NOW).created).toBe('2026-08-31 by Jo Owner');
		process.env.TZ = 'Pacific/Kiritimati';
		expect(keyRow(key(), NOW).created).toBe('2026-09-01 by Jo Owner');
	});

	it('is live without an expiry, expired past it, revoked above all', () => {
		expect(keyState(key(), NOW)).toBe('live');
		expect(keyState(key({ expiresAt: '2026-10-01T00:00:00Z' }), NOW)).toBe('live');
		expect(keyState(key({ expiresAt: '2026-09-26T12:00:00Z' }), NOW)).toBe('expired');
		expect(keyState(key({ expiresAt: '2026-10-01T00:00:00Z', revokedAt: '2026-09-02T00:00:00Z' }), NOW)).toBe('revoked');
	});

	it('sorts live keys first, keeping the API’s order within each group', () => {
		const a = key({ id: 'a', revokedAt: '2026-09-02T00:00:00Z' });
		const b = key({ id: 'b' });
		const c = key({ id: 'c', expiresAt: '2026-09-10T00:00:00Z' });
		const d = key({ id: 'd' });
		expect(sortKeys([a, b, c, d], NOW).map((k) => k.id)).toEqual(['b', 'd', 'a', 'c']);
	});
});

describe('a key’s row', () => {
	it('shows the prefix only, the series, and never-ending and never-used keys in words', () => {
		const r = keyRow(key(), NOW);
		expect(r).toMatchObject({ shown: 'wm_3f2a9c1e_…', state: 'live', series: 'Any series', ends: 'Never', lastUsed: 'Never', canRevoke: true });
		expect(r.created).toMatch(/^2026-09-01 by Jo Owner$/);
	});

	it('lists the allowed series by label and says who revoked it', () => {
		const r = keyRow(
			key({
				allowedSeries: [
					{ kind: 'flow_logger_m3s', name: 'Weir' },
					{ kind: 'rain_catchment_mm', name: '' }
				],
				revokedAt: '2026-09-20T10:00:00Z',
				revokedBy: 'Jo Owner'
			}),
			NOW
		);
		expect(r.series).toBe('Flow — logger “Weir”, Rainfall — catchment');
		expect(r.ends).toBe('Revoked 2026-09-20 by Jo Owner');
		expect(r.canRevoke).toBe(false);
	});

	it('asks before a revoke, naming the key', () => {
		expect(revokeKeyQuestion('Weir gateway')).toContain('“Weir gateway”');
	});
});

describe('the curl example', () => {
	it('resolves a relative API URL against the page, and keeps an absolute one', () => {
		expect(apiBase('/api', 'https://water.example')).toBe('https://water.example/api');
		expect(apiBase('http://localhost:3001/', 'http://localhost:7777')).toBe('http://localhost:3001');
	});

	it('uses a placeholder for the key and the key’s first allowed series', () => {
		const text = curlExample('http://localhost:3001', { kind: 'rain_catchment_mm', name: 'Weir' }, '2026-09-25');
		expect(text).toContain('curl -X POST http://localhost:3001/ingest/v1/series/merge');
		expect(text).toContain('Bearer $WM_INGEST_KEY');
		expect(text).not.toMatch(/wm_[0-9a-f]{8}_/);
		expect(text).toContain('"kind":"rain_catchment_mm","name":"Weir","unit":"mm","startDate":"2026-09-25"');
		expect(curlExample('x', null, '2026-09-25')).toContain('"kind":"flow_logger_m3s"');
	});
});

describe('INGEST_EXAMPLE_BODY (issue #456)', () => {
	it('is a merge body: a known kind, a unit that kind takes, a date and daily values', () => {
		const body = JSON.parse(INGEST_EXAMPLE_BODY);
		expect(Object.keys(body).sort()).toEqual(['kind', 'name', 'source', 'startDate', 'unit', 'values']);
		expect(SERIES_KINDS).toContain(body.kind);
		expect(unitOptions(body.kind)).toContain(body.unit);
		expect(body.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(body.values).toEqual([0, 12.4, null]);
		expect(body.source.length).toBeLessThanOrEqual(100);
	});
});
