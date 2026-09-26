// The local bounce simulator (pnpm dev:mail:bounce) builds the event SES
// publishes, so the worker's own parser reads it as SES's (mail/suppression.ts).
import { describe, expect, it } from 'vitest';
import { parseMailEvent } from '../src/mail/suppression.js';
import { simulatedSesEvent } from './mail-bounce.js';

describe('simulatedSesEvent', () => {
	const now = new Date('2026-09-20T08:00:00Z');
	it('a bounce and a complaint parse as suppressions of that address; a transient bounce as nothing', () => {
		expect(parseMailEvent(JSON.stringify(simulatedSesEvent('a@example.com', 'bounce', now)))).toEqual({
			reason: 'bounce',
			addresses: ['a@example.com'],
			sentAt: '2026-09-20T08:00:00.000Z'
		});
		expect(parseMailEvent(JSON.stringify(simulatedSesEvent('a@example.com', 'complaint', now)))).toMatchObject({ reason: 'complaint', addresses: ['a@example.com'] });
		expect(parseMailEvent(JSON.stringify(simulatedSesEvent('a@example.com', 'transient', now)))).toBe('ignored');
	});
});
