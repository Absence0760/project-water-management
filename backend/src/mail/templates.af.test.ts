// The farmer emails in another language (WP-2.5), against a made-up
// catalogue that marks each word it supplies ("[af] …"): test data only,
// never wording that ships. The real af.ts holds only reviewed text.
import { describe, expect, it, vi } from 'vitest';

vi.mock('./i18n/af.js', async () => {
	const { en } = await vi.importActual<typeof import('./i18n/en.js')>('./i18n/en.js');
	// Complete for everything but the farmer invite's privacy line.
	const af = Object.fromEntries(Object.entries(en).filter(([k]) => k !== 'mail.farmer.privacy').map(([k, v]) => [k, `[af] ${v}`]));
	return { af };
});

const { farmerInviteMail, resetPasswordMail, verifyEmailMail } = await import('./templates.js');
const url = 'http://localhost:7777/verify-email?token=abc';

describe('farmer emails in Afrikaans', () => {
	it('verify and reset come out in the account’s language, marked lang="af", link and product intact', () => {
		for (const mail of [verifyEmailMail('ann@example.com', url, 'af'), resetPasswordMail('ann@example.com', url, 'af')]) {
			expect(mail.subject).toMatch(/^\[af\] .* — Water Management$/);
			expect(mail.html).toMatch(/<html lang="af">/);
			expect(mail.html).toContain(`href="${url}"`);
			expect(mail.html).toContain('[af] If the button');
			expect(mail.text).toContain(url);
			expect(mail.text).toContain('ann@example.com');
			expect(mail.text).not.toMatch(/^Please confirm|^Someone asked/m);
		}
	});

	it('an email with any word still in English is marked lang="en"', () => {
		const mail = farmerInviteMail('f@example.com', url, 'Ann', { catchment: 'Kloof', farms: ['Hoek', 'Rand'] }, 'sign-up', 'af');
		expect(mail.html).toMatch(/<html lang="en">/);
		expect(mail.text).toContain("You will see your own hydrological unit's water");
		// The farms are joined with the catalogue's "and".
		expect(mail.subject).toBe('[af] Ann invited you to see Hoek [af] and Rand in Kloof');
	});

	it('still escapes user-controlled names inside translated wording', () => {
		const mail = farmerInviteMail('f@example.com', url, 'Eve <b>', { catchment: '"><img src=x>', farms: ['<script>x</script>'] }, 'confirm', 'af');
		expect(mail.html).not.toContain('<script>');
		expect(mail.html).not.toContain('<img');
		expect(mail.html).toContain('&lt;script&gt;');
		expect(mail.text).toContain('[af] This link expires in 48 hours.');
	});

	it('English stays English whatever af holds', () => {
		expect(verifyEmailMail('ann@example.com', url).html).toMatch(/<html lang="en">/);
		expect(verifyEmailMail('ann@example.com', url, 'en').subject).toBe('Confirm your email address — Water Management');
	});
});
