import { describe, expect, it, vi } from 'vitest';

// A made-up "Afrikaans" catalogue that marks where each word came from: test
// data only, never wording that ships.
vi.mock('./af.js', () => ({ af: { 'mail.verify.heading': '[af] heading', 'mail.verify.body': '[af] {email} / {product}' } }));

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

	it('treats an unset or unknown locale as English', () => {
		expect(mailLocale(null)).toBe('en');
		expect(mailLocale('xx')).toBe('en');
		expect(mailLocale('af')).toBe('af');
		expect(mailT(undefined).lang).toBe('en');
	});
});
