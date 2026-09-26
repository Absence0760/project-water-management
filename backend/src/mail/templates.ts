// Email bodies: short, plain, accessible HTML (semantic markup, real link
// text, no images, no layout tables) plus a text alternative with the same
// content. Every interpolated value is HTML-escaped — project and team names
// and display names are user-controlled and these emails go to addresses the
// user merely typed in.
import type { Mail } from './transport.js';

export const PRODUCT = 'Water Management';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ESC[ch]!);

/** Absolute link into the site: SITE_URL + path + ?<param>=<token>. */
export function siteLink(path: string, token: string, param = 'token'): string {
	const base = (process.env.SITE_URL || 'http://localhost:7777').replace(/\/+$/, '');
	return `${base}${path}?${param}=${encodeURIComponent(token)}`;
}

type Body = { heading: string; paragraphs: string[]; action: { label: string; url: string }; footer: string[] };

function render(to: string, subject: string, b: Body): Mail {
	const text = [
		b.heading,
		'',
		...b.paragraphs.flatMap((p) => [p, '']),
		`${b.action.label}: ${b.action.url}`,
		'',
		...b.footer.flatMap((p) => [p, '']),
		`— ${PRODUCT}`
	].join('\n');
	const p = (s: string) => `<p style="margin:0 0 16px">${escapeHtml(s)}</p>`;
	const url = escapeHtml(b.action.url);
	const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:24px;background:#ffffff;color:#1a1a1a;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:16px;line-height:1.5">
<main style="max-width:560px">
<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(b.heading)}</h1>
${b.paragraphs.map(p).join('\n')}
<p style="margin:24px 0"><a href="${url}" style="display:inline-block;padding:10px 18px;background:#1d4e89;color:#ffffff;border-radius:6px;text-decoration:underline;font-weight:600">${escapeHtml(b.action.label)}</a></p>
<p style="margin:0 0 16px;font-size:14px">If the button doesn't work, copy this address into your browser:<br><a href="${url}" style="color:#1d4e89;word-break:break-all">${url}</a></p>
${b.footer.map(p).join('\n')}
<p style="margin:24px 0 0;font-size:14px;color:#4a4a4a">— ${PRODUCT}</p>
</main>
</body>
</html>`;
	return { to, subject, text, html };
}

export function verifyEmailMail(to: string, url: string): Mail {
	return render(to, `Confirm your email address — ${PRODUCT}`, {
		heading: 'Confirm your email address',
		paragraphs: [`Please confirm that ${to} is your email address for ${PRODUCT}.`],
		action: { label: 'Confirm email address', url },
		footer: ['This link expires in 48 hours.', "If you didn't create an account, you can ignore this email."]
	});
}

export function resetPasswordMail(to: string, url: string): Mail {
	return render(to, `Reset your password — ${PRODUCT}`, {
		heading: 'Reset your password',
		paragraphs: [
			`Someone asked to reset the password for the ${PRODUCT} account ${to}.`,
			'Choosing a new password signs you out on every device.'
		],
		action: { label: 'Choose a new password', url },
		footer: [
			'This link expires in 1 hour and works once.',
			"If you didn't ask for this, you can ignore this email — your password stays the same."
		]
	});
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
	return render(to, `${inviterName} invited you to ${PRODUCT}`, {
		heading: `You're invited to ${PRODUCT}`,
		paragraphs: confirm
			? [invited, `There is already a ${PRODUCT} account for ${to}. Confirm that this is your email address to accept.`]
			: [invited, `Create your ${PRODUCT} account with this email address (${to}) to accept.`],
		action: confirm
			? { label: 'Confirm email and accept', url }
			: { label: 'Create account and accept', url },
		footer: confirm
			? [
					'This link expires in 48 hours.',
					`If you never created a ${PRODUCT} account, someone else registered your address: don't confirm it — use “Forgot password” on the sign-in page to take the account over instead.`
				]
			: ['This invitation expires in 7 days.', "If you weren't expecting this, you can ignore this email."]
	});
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
};

/**
 * A report PDF is ready (WP-2.15 Phase B). The link opens the app's download
 * page, which needs the reader signed in and still a member of the project
 * before it hands out a short-lived download link: the email itself grants
 * nothing, and a forwarded one opens nothing for a non-member.
 */
export function reportReadyMail(to: string, url: string, f: ReportMailFacts): Mail {
	const pages = `${f.pages} ${f.pages === 1 ? 'page' : 'pages'}`;
	return render(to, `Catchment report: ${f.projectName} — ${PRODUCT}`, {
		heading: `The report for ${f.projectName} is ready`,
		paragraphs: [
			f.scheduled
				? `This is the scheduled report of the latest run, ${f.runName} (${pages}), set up by ${f.requestedBy}.`
				: `${f.requestedBy} made a PDF of the report for the run ${f.runName} (${pages}).`,
			'Sign in to download it. You need to be a member of the project.'
		],
		action: { label: 'Download the report', url },
		footer: ['The PDF is kept for 7 days.', "If you weren't expecting this, a member of the project sent it to you; you can ignore it."]
	});
}
