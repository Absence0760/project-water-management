// Outgoing email. One `sendMail` for the whole backend; the transport is picked
// by MAIL_TRANSPORT (docs/run-locally.md § Email, docs/deployment.md § Email):
//
//   log    — default when unset. Prints the message to the console; nothing is
//            sent. Needs no services at all. Inside Lambda it prints only the
//            mail's kind, so a misconfigured deploy never writes live reset
//            links, addresses or subjects into CloudWatch.
//   smtp   — nodemailer to SMTP_HOST:SMTP_PORT. Local dev points it at Mailpit
//            (`pnpm dev:mail:up`, UI on http://localhost:8026).
//   ses    — Amazon SES v2 SendEmail with the Lambda's IAM role (production).
//   memory — tests only: messages collect in `outbox`.
//
// The SDK clients are imported lazily, so the log/memory paths (and the unit
// tests) never load nodemailer or the AWS SDK.

import { safeError } from '../logging/safeError.js';
import { logEvent } from '../logging/logEvent.js';

/** Which email this is, for logs: a failed send is logged by kind, never by subject or recipient. */
export type MailKind = 'verify' | 'account_exists' | 'reset' | 'invite' | 'farmer_invite' | 'report_ready' | 'alert' | 'alert_digest' | 'pack_notice';

export type Mail = {
	/** Set by every template (mail/templates.ts, mail/alerts.ts); the log line's `kind`. */
	kind?: MailKind;
	to: string;
	subject: string;
	text: string;
	html: string;
	/**
	 * Extra headers (alert mails: List-Unsubscribe and List-Unsubscribe-Post,
	 * RFC 8058; Auto-Submitted, RFC 3834). Values are made one line before
	 * sending, and a name must be a plain header token.
	 */
	headers?: Record<string, string>;
};

type Send = (mail: Mail, from: string) => Promise<void>;

/** Messages "sent" with MAIL_TRANSPORT=memory (tests read tokens from here). */
export const outbox: Mail[] = [];

const inLambda = () => !!process.env.AWS_LAMBDA_FUNCTION_NAME;

let cached: { key: string; send: Send } | undefined;

/** Strip CR/LF so user-controlled text (project names) can't inject headers. */
export const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;

/** A mail's extra headers, each value on one line; a name that isn't a header token is refused. */
export function safeHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (!HEADER_NAME.test(name)) throw new Error(`not a header name: ${JSON.stringify(name)}`);
		out[name] = oneLine(value);
	}
	return out;
}

async function createTransport(kind: string): Promise<Send> {
	switch (kind) {
		case 'memory':
			return async (mail) => {
				outbox.push(mail);
			};
		case 'log':
			return async (mail) => {
				if (inLambda()) {
					// The kind only: a subject can carry a person's or a farm's name.
					console.warn(`MAIL_TRANSPORT=log: not sending a "${mail.kind ?? 'unknown'}" email (set MAIL_TRANSPORT=ses)`);
					return;
				}
				const extra = Object.entries(mail.headers ?? {}).map(([k, v]) => `${k}: ${v}\n`).join('');
				console.info(`\n--- email (MAIL_TRANSPORT=log, not sent) ---\nTo: ${mail.to}\nSubject: ${mail.subject}\n${extra}\n${mail.text}\n---\n`);
			};
		case 'smtp': {
			const user = process.env.SMTP_USER ?? '';
			const pass = process.env.SMTP_PASSWORD ?? '';
			// Half a credential is a misconfiguration; fail loudly, not with a
			// confusing "authentication failed" from the server.
			if (!!user !== !!pass) throw new Error('set both SMTP_USER and SMTP_PASSWORD, or neither');
			const { createTransport: smtp } = await import('nodemailer');
			const transporter = smtp({
				host: process.env.SMTP_HOST ?? '127.0.0.1',
				port: Number(process.env.SMTP_PORT ?? 1026),
				secure: process.env.SMTP_SECURE === 'true',
				...(user ? { auth: { user, pass } } : {})
			});
			return async (mail, from) => {
				await transporter.sendMail({ from, to: mail.to, subject: oneLine(mail.subject), text: mail.text, html: mail.html, headers: mail.headers });
			};
		}
		case 'ses': {
			const { SESv2Client, SendEmailCommand } = await import('@aws-sdk/client-sesv2');
			// Credentials come from the Lambda's IAM role; the region is the
			// Lambda's own unless SES_REGION overrides it (docs/deployment.md § Email).
			const client = new SESv2Client(process.env.SES_REGION ? { region: process.env.SES_REGION } : {});
			const configurationSet = process.env.SES_CONFIGURATION_SET || undefined;
			return async (mail, from) => {
				await client.send(
					new SendEmailCommand({
						FromEmailAddress: from,
						Destination: { ToAddresses: [mail.to] },
						ConfigurationSetName: configurationSet,
						Content: {
							Simple: {
								Subject: { Data: oneLine(mail.subject), Charset: 'UTF-8' },
								Body: {
									Text: { Data: mail.text, Charset: 'UTF-8' },
									Html: { Data: mail.html, Charset: 'UTF-8' }
								},
								// SESv2 Simple content takes custom headers (@aws-sdk/client-sesv2 ≥ 3.6xx; MessageHeader).
								...(mail.headers ? { Headers: Object.entries(mail.headers).map(([Name, Value]) => ({ Name, Value })) } : {})
							}
						}
					})
				);
			};
		}
		default:
			throw new Error(`unknown MAIL_TRANSPORT "${kind}" (expected log, smtp, ses or memory)`);
	}
}

/**
 * One bare address: no display name, list, group or line break. Making `to`
 * one line is not enough: nodemailer reads "a@x.com Bcc: b@y.com" as a group
 * addressed to b@y.com only, and "a@x.com, b@y.com" as two recipients. Every
 * address the app mails was checked as an email where it came in (zod
 * `.email()`); this is the transport's own check, so a path that forgets
 * can't turn one mail into another recipient's.
 */
const SINGLE_ADDRESS = /^[^\s@,;:<>()[\]"\\]+@[^\s@,;:<>()[\]"\\]+$/;

/** Send one email. Throws on transport failure — callers decide whether that matters. */
export async function sendMail(mail: Mail): Promise<void> {
	const to = mail.to.trim();
	if (!SINGLE_ADDRESS.test(to)) throw new Error('refusing to send: the recipient is not a single email address');
	const kind = process.env.MAIL_TRANSPORT || 'log';
	if (cached?.key !== kind) cached = { key: kind, send: await createTransport(kind) };
	const from = process.env.MAIL_FROM || 'Water Management <no-reply@localhost>';
	await cached.send({ ...mail, to, headers: safeHeaders(mail.headers) }, from);
}

/**
 * Send, but never fail the request over it: a mail outage must not turn
 * "we sent you a link" endpoints into 500s (or, for forgot-password, into a
 * response that differs for known and unknown addresses). The failure is
 * one structured line, `{"event":"mail_send_failed","kind",…}`, which the
 * `mail-send-failed` alarm counts (infra/alarms.tf): the mail's kind and the
 * error's name/code only. Never the recipient, the subject (an invite's names
 * a person and their farms) or the error's text (SES writes the recipient's
 * address into it), and never the body, which carries a live token.
 */
export async function trySendMail(mail: Mail): Promise<boolean> {
	try {
		await sendMail(mail);
		return true;
	} catch (err) {
		logEvent('error', { event: 'mail_send_failed', kind: mail.kind ?? 'unknown', ...safeError(err) });
		return false;
	}
}
