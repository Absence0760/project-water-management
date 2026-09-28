import { describe, expect, it, vi } from 'vitest';

// A made-up "Afrikaans" catalogue that marks where each word came from: test
// data only, never wording that ships.
vi.mock('./af.js', () => ({
	af: {
		'mail.verify.heading': '[af] heading',
		'mail.verify.body': '[af] {email} / {product}',
		'mail.alert.jobs.body.one': '[af one] {count}',
		'mail.alert.jobs.body.other': '[af other] {count}',
		'mail.alert.failing.line.other': '[af other] {failures}'
	}
}));

const { fill, mailLocale, mailT } = await import('./index.js');

describe('mailT', () => {
	it('fills placeholders and leaves an unknown one showing', () => {
		expect(mailT('en').t('mail.verify.body', { email: 'a@b.c', product: 'P' })).toBe('Please confirm that a@b.c is your email address for P.');
		expect(fill('{a} {b}', { a: 'x' })).toBe('x {b}');
	});

	it('uses Afrikaans where it has a translation and says so in lang', () => {
		const tr = mailT('af');
		expect(tr.t('mail.verify.heading')).toBe('[af] heading');
		expect(tr.t('mail.verify.body', { email: 'a@b.c', product: 'P' })).toBe('[af] a@b.c / P');
		expect(tr.lang).toBe('af');
	});

	it('falls back to English key by key, and then marks the email English', () => {
		const tr = mailT('af');
		tr.t('mail.verify.heading');
		expect(tr.t('mail.verify.action')).toBe('Confirm email address');
		expect(tr.lang).toBe('en');
	});

	// Issue #51: "1 days late", "1 background jobs failed".
	it('picks a counted message’s form by the language’s plural rules', () => {
		const en = mailT('en');
		expect(en.tn('mail.alert.jobs.body', 1, { count: 1 })).toMatch(/^1 background job failed /);
		expect(en.tn('mail.alert.jobs.body', 2, { count: 2 })).toMatch(/^2 background jobs failed /);
		expect(en.tn('mail.alert.stale.line', 1, { feed: 'CHIRPS', newest: '2 Jan 2026', overdue: 1 })).toBe('CHIRPS: newest day 2 Jan 2026, 1 day late');
		expect(en.tn('mail.alert.stale.line', 0, { feed: 'CHIRPS', newest: '2 Jan 2026', overdue: 0 })).toBe('CHIRPS: newest day 2 Jan 2026, 0 days late');
		const af = mailT('af');
		expect(af.tn('mail.alert.jobs.body', 1, { count: 1 })).toBe('[af one] 1');
		expect(af.tn('mail.alert.jobs.body', 3, { count: 3 })).toBe('[af other] 3');
		expect(af.lang).toBe('af');
	});

	it('falls back to English, with English’s rules, when the language lacks the form', () => {
		const af = mailT('af');
		expect(af.tn('mail.alert.failing.line', 4, { feed: 'X', failures: 4 })).toBe('[af other] 4');
		expect(af.lang).toBe('af');
		expect(af.tn('mail.alert.failing.line', 1, { feed: 'X', failures: 1 })).toBe('X: 1 failure in a row');
		expect(af.lang).toBe('en');
	});

	it('treats an unset or unknown locale as English', () => {
		expect(mailLocale(null)).toBe('en');
		expect(mailLocale('xx')).toBe('en');
		expect(mailLocale('af')).toBe('af');
		expect(mailT(undefined).lang).toBe('en');
	});
});
