// Reading the emails the app sent, from the local Mailpit (`pnpm dev:mail:up`;
// CI starts it): its HTTP API at MAILPIT_URL. For the specs whose emails come
// from the API or the worker through SMTP (playwright.config.ts: the second
// e2e API, `MFA_API_URL`, sends through Mailpit; support/jobs.ts's tick does
// too). A spec checks `mailpitUp()` and skips locally without it, never in CI.
import { expect } from '@playwright/test';

export const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8026';

export const mailpitUp = () =>
	fetch(`${MAILPIT}/api/v1/info`, { signal: AbortSignal.timeout(1500) })
		.then((r) => r.ok)
		.catch(() => false);

export interface Email {
	id: string;
	subject: string;
	to: string[];
	text: string;
	html: string;
}

async function search(to: string): Promise<{ ID: string; Subject: string }[]> {
	const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=50`);
	expect(res.ok, 'Mailpit search').toBe(true);
	return ((await res.json()) as { messages: { ID: string; Subject: string }[] }).messages;
}

async function read(id: string): Promise<Email> {
	const m = (await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json()) as { ID: string; Subject: string; To: { Address: string }[]; Text: string; HTML: string };
	return { id: m.ID, subject: m.Subject, to: m.To.map((t) => t.Address), text: m.Text, html: m.HTML };
}

/**
 * The newest email to `to` whose subject matches, waiting for it to arrive
 * (Mailpit's API polled until it is there: the send happens after the
 * response, so it can land a moment later). `after`: ids already seen, so a
 * second email with the same subject isn't mistaken for the first.
 */
export async function waitForEmail(to: string, subject: string | RegExp, after: readonly string[] = []): Promise<Email> {
	let found: string | undefined;
	await expect
		.poll(
			async () => {
				const hit = (await search(to)).find((m) => !after.includes(m.ID) && (typeof subject === 'string' ? m.Subject === subject : subject.test(m.Subject)));
				found = hit?.ID;
				return !!found;
			},
			{ message: `an email to ${to}: ${subject}` }
		)
		.toBe(true);
	return read(found!);
}

/** Every email id to `to` so far. */
export const emailIds = async (to: string) => (await search(to)).map((m) => m.ID);

/** The one link in an email's text that starts with `prefix` (the site's address and path). */
export function linkIn(email: Email, prefix: string): URL {
	const links = [...email.text.matchAll(/https?:\/\/\S+/g)].map((m) => m[0]).filter((l) => l.startsWith(prefix));
	expect(links, `a link to ${prefix} in "${email.subject}"`).toHaveLength(1);
	return new URL(links[0]!);
}
