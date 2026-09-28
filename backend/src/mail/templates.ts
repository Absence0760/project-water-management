// Email bodies: short, plain, accessible HTML (semantic markup, real link
// text, no images, no layout tables) plus a text alternative with the same
// content. Every interpolated value is HTML-escaped — project and team names
// and display names are user-controlled and these emails go to addresses the
// user merely typed in.
import { LOCALES, mailT, type Locale, type MailTranslator } from './i18n/index.js';
import type { Mail, MailKind } from './transport.js';

// The farmer-facing emails (verify, reset, the farmer invite) take their
// words from the catalogue in ./i18n (WP-2.5). The workspace's own emails
// (project/team invites, report ready) stay English, as the workspace does.
export { LOCALES, type Locale };

export const PRODUCT = 'Water Management';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ESC[ch]!);

/** Absolute link into the site: SITE_URL + path + ?<param>=<token>. */
export function siteLink(path: string, token: string, param = 'token'): string {
	const base = (process.env.SITE_URL || 'http://localhost:7777').replace(/\/+$/, '');
	return `${base}${path}?${param}=${encodeURIComponent(token)}`;
}

export type Body = {
	heading: string;
	paragraphs: string[];
	action: { label: string; url: string };
	footer: string[];
	/** Small links under the footer (an alert's unsubscribe and manage links), as real links in HTML and "label: url" in text. */
	links?: { label: string; url: string }[];
};

/** `tr` supplies the frame's words and, through `tr.lang`, the `<html lang>`; read after the body is built, so it knows whether anything fell back to English. */
export function render(kind: MailKind, to: string, subject: string, b: Body, tr: MailTranslator = mailT('en')): Mail {
	const links = b.links ?? [];
	const fallbackLine = tr.t('mail.buttonFallback');
	const text = [
		b.heading,
		'',
		...b.paragraphs.flatMap((p) => [p, '']),
		`${b.action.label}: ${b.action.url}`,
		'',
		...b.footer.flatMap((p) => [p, '']),
		...links.flatMap((l) => [`${l.label}: ${l.url}`, '']),
		`— ${PRODUCT}`
	].join('\n');
	const p = (s: string) => `<p style="margin:0 0 16px">${escapeHtml(s)}</p>`;
	const url = escapeHtml(b.action.url);
	const html = `<!doctype html>
<html lang="${tr.lang}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:24px;background:#ffffff;color:#1a1a1a;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:16px;line-height:1.5">
<main style="max-width:560px">
<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(b.heading)}</h1>
${b.paragraphs.map(p).join('\n')}
<p style="margin:24px 0"><a href="${url}" style="display:inline-block;padding:10px 18px;background:#1d4e89;color:#ffffff;border-radius:6px;text-decoration:underline;font-weight:600">${escapeHtml(b.action.label)}</a></p>
<p style="margin:0 0 16px;font-size:14px">${escapeHtml(fallbackLine)}<br><a href="${url}" style="color:#1d4e89;word-break:break-all">${url}</a></p>
${b.footer.map(p).join('\n')}${links.length ? `\n<p style="margin:0 0 16px;font-size:14px">${links.map((l) => `<a href="${escapeHtml(l.url)}" style="color:#1d4e89">${escapeHtml(l.label)}</a>`).join(' · ')}</p>` : ''}
<p style="margin:24px 0 0;font-size:14px;color:#4a4a4a">— ${PRODUCT}</p>
</main>
</body>
</html>`;
	return { kind, to, subject, text, html };
}

export function verifyEmailMail(to: string, url: string, locale?: string | null): Mail {
	const tr = mailT(locale);
	const v = { email: to, product: PRODUCT };
	return render(
		'verify',
		to,
		tr.t('mail.verify.subject', v),
		{
			heading: tr.t('mail.verify.heading'),
			paragraphs: [tr.t('mail.verify.body', v)],
			action: { label: tr.t('mail.verify.action'), url },
			footer: [tr.t('mail.verify.expires'), tr.t('mail.verify.ignore')]
		},
		tr
	);
}

/**
 * To the owner of an address someone signed up with again (auth/routes.ts
 * /register): the sign-up page answers the same for a new and a taken
 * address, so the owner learns it here, with a password-reset link in case
 * they forgot theirs.
 */
export function accountExistsMail(to: string, url: string, locale?: string | null): Mail {
	const tr = mailT(locale);
	const v = { email: to, product: PRODUCT };
	return render(
		'account_exists',
		to,
		tr.t('mail.exists.subject', v),
		{
			heading: tr.t('mail.exists.heading'),
			paragraphs: [tr.t('mail.exists.body', v), tr.t('mail.exists.signIn')],
			action: { label: tr.t('mail.exists.action'), url },
			footer: [tr.t('mail.reset.expires'), tr.t('mail.exists.ignore')]
		},
		tr
	);
}

export function resetPasswordMail(to: string, url: string, locale?: string | null): Mail {
	const tr = mailT(locale);
	const v = { email: to, product: PRODUCT };
	return render(
		'reset',
		to,
		tr.t('mail.reset.subject', v),
		{
			heading: tr.t('mail.reset.heading'),
			paragraphs: [tr.t('mail.reset.body', v), tr.t('mail.reset.signsOut')],
			action: { label: tr.t('mail.reset.action'), url },
			footer: [tr.t('mail.reset.expires'), tr.t('mail.reset.ignore')]
		},
		tr
	);
}

export type InviteTarget = { kind: 'project' | 'team'; name: string; role: string };

/**
 * `sign-up`: the address has no account; the link is `/register?invite=…`.
 * `confirm`: an unverified account already has the address; the link is a
 * verify-email link, and confirming accepts the invitation.
 */
export function inviteMail(
	to: string,
	url: string,
	inviterName: string,
	target: InviteTarget,
	mode: 'sign-up' | 'confirm' = 'sign-up'
): Mail {
	const what = target.kind === 'project' ? `the catchment project “${target.name}”` : `the team “${target.name}”`;
	const invited = `${inviterName} invited you to ${what} as ${/^[aeiou]/i.test(target.role) ? 'an' : 'a'} ${target.role}.`;
	const confirm = mode === 'confirm';
	return render('invite', to, `${inviterName} invited you to ${PRODUCT}`, {
		heading: `You're invited to ${PRODUCT}`,
		paragraphs: confirm
			? [invited, `There is already a ${PRODUCT} account for ${to}. Confirm that this is your email address to accept.`]
			: [invited, `Create your ${PRODUCT} account with this email address (${to}) to accept.`],
		action: confirm
			? { label: 'Confirm email and accept', url }
			: { label: 'Create account and accept', url },
		// The privacy notice's address: an invitee's details are processed before they reach sign-up (POPIA s18).
		footer: (confirm
			? [
					'This link expires in 48 hours.',
					`If you never created a ${PRODUCT} account, someone else registered your address: don't confirm it — use “Forgot password” on the sign-in page to take the account over instead.`
				]
			: ['This invitation expires in 7 days.', "If you weren't expecting this, you can ignore this email."]
		).concat(`How we handle your information: ${sitePage('/privacy')}`)
	});
}

/** "A", "A and B", "A, B and C". */
export function listText(items: readonly string[], and = 'and'): string {
	if (items.length <= 1) return items[0] ?? '';
	return `${items.slice(0, -1).join(', ')} ${and} ${items.at(-1)}`;
}

export type FarmerInviteFacts = { catchment: string; farms: string[] };

/**
 * A farmer invite (WP-2.2): "{inviter} has given you access to {farm} in
 * {catchment}". Same two modes as `inviteMail`; `locale` (invite.locale)
 * picks the wording, English where Afrikaans has none yet.
 */
export function farmerInviteMail(
	to: string,
	url: string,
	inviterName: string,
	facts: FarmerInviteFacts,
	mode: 'sign-up' | 'confirm' = 'sign-up',
	locale: Locale = 'en'
): Mail {
	const tr = mailT(locale);
	const confirm = mode === 'confirm';
	const farms = facts.farms.length ? listText(facts.farms, tr.t('mail.farmer.and')) : tr.t('mail.farmer.yourFarm');
	const v = { inviter: inviterName, farms, catchment: facts.catchment, email: to, product: PRODUCT };
	return render(
		'farmer_invite',
		to,
		tr.t('mail.farmer.subject', v),
		{
			heading: tr.t('mail.farmer.heading', v),
			paragraphs: [
				tr.t('mail.farmer.body', v),
				tr.t('mail.farmer.privacy'),
				// Before the sign-up button: the farmer reads it before they can see a figure (CPA s49 research, R4).
				tr.t('mail.farmer.estimate'),
				tr.t(confirm ? 'mail.invite.confirm' : 'mail.invite.signUp', v)
			],
			action: { label: tr.t(confirm ? 'mail.invite.confirmAction' : 'mail.invite.signUpAction'), url },
			// The privacy notice's address: a farmer's details are processed before they reach sign-up (POPIA s18).
			footer: [
				...(confirm
					? [tr.t('mail.invite.confirmExpires'), tr.t('mail.invite.confirmTakeOver', v)]
					: [tr.t('mail.invite.signUpExpires'), tr.t('mail.invite.signUpIgnore')]),
				tr.t('mail.invite.privacy', { url: sitePage('/privacy') })
			]
		},
		tr
	);
}

/** Absolute link to a page of the site (no token). */
export function sitePage(path: string): string {
	return `${(process.env.SITE_URL || 'http://localhost:7777').replace(/\/+$/, '')}${path}`;
}

export type ReportMailFacts = {
	projectName: string;
	/** The run's label, or its date when it has none. */
	runName: string;
	pages: number;
	/** Who asked, or who set up the schedule. */
	requestedBy: string;
	scheduled: boolean;
	/** An impact report (the run against a baseline, 082); a schedule never makes one. */
	impact?: boolean;
};

/**
 * A report PDF is ready (WP-2.15 Phase B). The link opens the app's download
 * page, which needs the reader signed in and still a member of the project
 * before it hands out a short-lived download link: the email itself grants
 * nothing, and a forwarded one opens nothing for a non-member.
 */
export function reportReadyMail(to: string, url: string, f: ReportMailFacts): Mail {
	const pages = `${f.pages} ${f.pages === 1 ? 'page' : 'pages'}`;
	return render('report_ready', to, `Catchment report: ${f.projectName} — ${PRODUCT}`, {
		heading: `The report for ${f.projectName} is ready`,
		paragraphs: [
			f.scheduled
				? `This is the scheduled report of the latest run, ${f.runName} (${pages}), set up by ${f.requestedBy}.`
				: `${f.requestedBy} made a PDF of the ${f.impact ? 'impact report' : 'report'} for the run ${f.runName} (${pages}).`,
			'Sign in to download it. You need to be a member of the project.'
		],
		action: { label: 'Download the report', url },
		footer: ['The PDF is kept for 7 days.', "If you weren't expecting this, a member of the project sent it to you; you can ignore it."]
	});
}
