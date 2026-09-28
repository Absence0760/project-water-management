// Proof that a language is one table entry plus its email catalogue (issue
// #58; docs/ui.md § Adding a language). The engine's language table is
// mocked with a stand-in `xx` ("Xx-test", en-US dates) and the catalogue
// index with a stand-in catalogue for it, and with no other code change the
// emails are sent in it. The stand-in exists only in this file: no `xx`
// catalogue ships. The route validation and the database side are proven in
// src/auth/locale.db.test.ts.
import { describe, expect, it, vi } from 'vitest';

vi.mock('@water-management/engine/languages', async (importOriginal) => {
	const real = await importOriginal<typeof import('@water-management/engine/languages')>();
	return { ...real, ...real.languageTable([...real.LANGUAGES, { code: 'xx', name: 'Xx-test', intl: 'en-US', decimalMark: ',' }]) };
});
vi.mock('./catalogues.js', async (importOriginal) => {
	const real = await importOriginal<typeof import('./catalogues.js')>();
	return { CATALOGUES: { ...real.CATALOGUES, xx: { 'mail.verify.heading': '[xx] heading', 'mail.verify.subject': '[xx] {product}' } } };
});

const { LOCALES, mailLocale, mailT } = await import('./index.js');
const { dateText } = await import('../alerts.js');
const { verifyEmailMail } = await import('../templates.js');

describe('a stand-in language added to the table and the catalogue index only', () => {
	it('is a language a person can have', () => {
		expect(LOCALES).toContain('xx');
		expect(mailLocale('xx')).toBe('xx');
	});

	it('is what mailT writes in, falling back to English key by key', () => {
		const tr = mailT('xx');
		expect(tr.t('mail.verify.heading')).toBe('[xx] heading');
		expect(tr.lang).toBe('xx');
		expect(tr.t('mail.verify.action')).toBe('Confirm email address');
		expect(tr.lang).toBe('en');
	});

	it('dates an email in its Intl locale', () => {
		expect(dateText('2026-09-20', 'xx' as never)).toBe('Sep 20, 2026');
	});

	it('reaches a finished email, subject included', () => {
		const mail = verifyEmailMail('a@example.com', 'http://localhost/verify', 'xx' as never);
		expect(mail.subject).toMatch(/^\[xx\] /);
	});
});
