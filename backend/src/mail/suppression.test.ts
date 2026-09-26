// Parsing SES bounce and complaint events (mail/suppression.ts). The database
// side (app_mail_suppress, the paused alerts, the resume route) is in
// alerts/suppression.db.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bareAddress, MAX_EVENT_BYTES, MAX_RECIPIENTS, parseMailEvent, releaseAddress } from './suppression.js';

const mail = { timestamp: '2026-09-20T08:00:00.000Z', source: 'no-reply@example.com', messageId: 'x', destination: ['a@example.com'], tags: {} };
const bounce = (bounceType: string, emails = ['a@example.com']) =>
	JSON.stringify({ eventType: 'Bounce', mail, bounce: { bounceType, bounceSubType: 'General', bouncedRecipients: emails.map((emailAddress) => ({ emailAddress, action: 'failed' })), timestamp: mail.timestamp } });
const complaint = (emails = ['a@example.com']) =>
	JSON.stringify({ eventType: 'Complaint', mail, complaint: { complainedRecipients: emails.map((emailAddress) => ({ emailAddress })), complaintFeedbackType: 'abuse', timestamp: mail.timestamp } });

describe('parseMailEvent', () => {
	it('a permanent bounce suppresses its recipients, with when the mail was sent', () => {
		expect(parseMailEvent(bounce('Permanent', ['a@example.com', 'b@example.com']))).toEqual({
			reason: 'bounce',
			addresses: ['a@example.com', 'b@example.com'],
			sentAt: '2026-09-20T08:00:00.000Z'
		});
	});

	it('a complaint suppresses its recipients', () => {
		expect(parseMailEvent(complaint())).toEqual({ reason: 'complaint', addresses: ['a@example.com'], sentAt: '2026-09-20T08:00:00.000Z' });
	});

	it('a transient or undetermined bounce (a full mailbox) is well formed but suppresses nothing', () => {
		expect(parseMailEvent(bounce('Transient'))).toBe('ignored');
		expect(parseMailEvent(bounce('Undetermined'))).toBe('ignored');
	});

	it('accepts the older identity-notification shape (notificationType) too', () => {
		const e = JSON.parse(bounce('Permanent'));
		delete e.eventType;
		e.notificationType = 'Bounce';
		expect(parseMailEvent(JSON.stringify(e))).toMatchObject({ reason: 'bounce' });
	});

	it('refuses anything that is not an SES bounce or complaint', () => {
		for (const body of [
			'garbage',
			'null',
			JSON.stringify({ eventType: 'Delivery', mail }),
			JSON.stringify({ eventType: 'Bounce', mail }),
			JSON.stringify({ eventType: 'Bounce', mail, bounce: { bounceType: 'Permanent', bouncedRecipients: [] } }),
			JSON.stringify({ eventType: 'Complaint', mail, bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'a@example.com' }] } }),
			// A job message (the worker's other queues) is not one.
			JSON.stringify({ v: 1, type: 'wake', jobId: '00000000-0000-4000-8000-000000000000' }),
			// An SNS envelope (raw delivery off): the Message isn't read.
			JSON.stringify({ Type: 'Notification', Message: bounce('Permanent') })
		]) {
			expect(parseMailEvent(body), body.slice(0, 60)).toBeNull();
		}
	});

	it('is bounded: too many recipients, an over-long address or an oversized body is refused', () => {
		expect(parseMailEvent(bounce('Permanent', Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => `u${i}@example.com`)))).toBeNull();
		expect(parseMailEvent(bounce('Permanent', [`${'a'.repeat(320)}@example.com`]))).toBeNull();
		const big = JSON.parse(bounce('Permanent'));
		big.padding = 'x'.repeat(MAX_EVENT_BYTES);
		expect(parseMailEvent(JSON.stringify(big))).toBeNull();
		// Positive control: the most recipients SES sends is fine.
		expect(parseMailEvent(bounce('Permanent', Array.from({ length: MAX_RECIPIENTS }, (_, i) => `u${i}@example.com`)))).toMatchObject({ reason: 'bounce' });
	});
});

describe('bareAddress', () => {
	it('takes the address out of a display-name form, and leaves a bare one alone', () => {
		expect(bareAddress('Ann Farmer <ann@example.com>')).toBe('ann@example.com');
		expect(bareAddress(' ann@example.com ')).toBe('ann@example.com');
	});
});

describe('releaseAddress', () => {
	afterEach(() => vi.unstubAllEnvs());

	it('does nothing without SES (every local transport has no suppression list)', async () => {
		for (const t of ['', 'log', 'smtp', 'memory']) {
			vi.stubEnv('MAIL_TRANSPORT', t);
			await expect(releaseAddress('a@example.com')).resolves.toBeUndefined();
		}
	});
});
