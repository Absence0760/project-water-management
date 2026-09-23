// Outgoing email. One `sendMail` for the whole backend; the transport is picked
// by MAIL_TRANSPORT (docs/run-locally.md § Email, docs/deployment.md § Email):
//
//   log    — default when unset. Prints the message to the console; nothing is
//            sent. Needs no services at all. Inside Lambda it prints only the
//            recipient + subject, so a misconfigured deploy never writes live
//            reset links into CloudWatch.
//   smtp   — nodemailer to SMTP_HOST:SMTP_PORT. Local dev points it at Mailpit
//            (`pnpm dev:mail:up`, UI on http://localhost:8026).
//   ses    — Amazon SES v2 SendEmail with the Lambda's IAM role (production).
//   memory — tests only: messages collect in `outbox`.
//
// The SDK clients are imported lazily, so the log/memory paths (and the unit
// tests) never load nodemailer or the AWS SDK.

export type Mail = { to: string; subject: string; text: string; html: string };

type Send = (mail: Mail, from: string) => Promise<void>;

/** Messages "sent" with MAIL_TRANSPORT=memory (tests read tokens from here). */
export const outbox: Mail[] = [];

const inLambda = () => !!process.env.AWS_LAMBDA_FUNCTION_NAME;

let cached: { key: string; send: Send } | undefined;

/** Strip CR/LF so user-controlled text (project names) can't inject headers. */
export const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

async function createTransport(kind: string): Promise<Send> {
	switch (kind) {
		case 'memory':
			return async (mail) => {
				outbox.push(mail);
			};
		case 'log':
			return async (mail) => {
				if (inLambda()) {
					console.warn(`MAIL_TRANSPORT=log: not sending "${mail.subject}" (set MAIL_TRANSPORT=ses)`);
					return;
				}
				console.info(`\n--- email (MAIL_TRANSPORT=log, not sent) ---\nTo: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}\n---\n`);
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
				await transporter.sendMail({ from, to: mail.to, subject: oneLine(mail.subject), text: mail.text, html: mail.html });
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
								}
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

/** Send one email. Throws on transport failure — callers decide whether that matters. */
export async function sendMail(mail: Mail): Promise<void> {
	const kind = process.env.MAIL_TRANSPORT || 'log';
	if (cached?.key !== kind) cached = { key: kind, send: await createTransport(kind) };
	const from = process.env.MAIL_FROM || 'Water Management <no-reply@localhost>';
	await cached.send({ ...mail, to: oneLine(mail.to) }, from);
}

/**
 * Send, but never fail the request over it: a mail outage must not turn
 * "we sent you a link" endpoints into 500s (or, for forgot-password, into a
 * response that differs for known and unknown addresses). The failure is
 * logged without the message body, which carries a live token.
 */
export async function trySendMail(mail: Mail): Promise<boolean> {
	try {
		await sendMail(mail);
		return true;
	} catch (err) {
		console.error(`email "${oneLine(mail.subject)}" failed:`, (err as Error).message);
		return false;
	}
}
