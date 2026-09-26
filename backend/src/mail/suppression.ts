// Mail suppression (WP-2.13 follow-up; 057_alert_followups.sql,
// docs/security.md § Alerts, docs/deployment.md § Email).
//
// SES already stops mailing an address that hard-bounced or complained (the
// configuration set's suppression list, infra/ses.tf). This tells the app:
//
//   SES configuration set ── BOUNCE, COMPLAINT ──> SNS `ses-events`
//     ──(raw delivery)──> SQS `mail-events` ──> worker Lambda (lambda-worker.ts)
//     ──> acceptMailEvent ──> app_mail_suppress: the person's flag, their
//         alert emails paused, their waiting deliveries skipped
//
// Locally there is no SES: `pnpm dev:mail:bounce <email> [--complaint]`
// (scripts/mail-bounce.ts) builds the same event and runs it through the
// same acceptMailEvent.
//
// Trust: the worker takes a record as an SES event only when it came from the
// mail-events queue (its event source ARN is MAIL_EVENTS_QUEUE_ARN), and that
// queue accepts messages only from the ses-events topic, which accepts them
// only from SES for this configuration set (the policies in infra/ses.tf).
// The body is still parsed strictly (zod, a size limit, at most
// MAX_RECIPIENTS addresses), and only a permanent bounce or a complaint
// suppresses anything: a transient bounce (a full mailbox) doesn't.
//
// Turning mail back on (POST /me/alerts/resume) must also take the address
// off SES's account-level suppression list, or SES would drop the next mail
// and report it as a bounce again: releaseAddress does that with
// MAIL_TRANSPORT=ses, and is a no-op for every local transport.
import { z } from 'zod';
import { withoutUser } from '../db/tx.js';

export type SuppressionReason = 'bounce' | 'complaint';

/** An SQS body larger than this is not an SES event (they are a few KB). */
export const MAX_EVENT_BYTES = 64 * 1024;
/** SES sends up to 50 recipients per message; more is not an SES event. */
export const MAX_RECIPIENTS = 50;

const Address = z.string().min(3).max(320);
const Recipients = z.array(z.object({ emailAddress: Address }).passthrough()).min(1).max(MAX_RECIPIENTS);
const Mail = z.object({ timestamp: z.string().datetime({ offset: true }).optional() }).passthrough();

/**
 * The SES event publishing record (an event destination's message, with SNS
 * raw message delivery). Only the fields the app uses are read; the rest is
 * ignored. `eventType` is the event-publishing name; `notificationType` the
 * older identity-notification name, accepted too so a misconfigured
 * destination still works.
 */
const Kind = (k: 'Bounce' | 'Complaint') =>
	z.object({ eventType: z.string().max(40).optional(), notificationType: z.string().max(40).optional() }).refine((e) => (e.eventType ?? e.notificationType) === k);
const SesBounce = z.object({
	mail: Mail.optional(),
	bounce: z.object({ bounceType: z.string().max(40), bouncedRecipients: Recipients }).passthrough()
});
const SesComplaint = z.object({
	mail: Mail.optional(),
	complaint: z.object({ complainedRecipients: Recipients }).passthrough()
});

export interface MailEvent {
	reason: SuppressionReason;
	addresses: string[];
	/** When SES accepted the mail this is about (mail.timestamp), if it said. */
	sentAt: string | null;
}

/**
 * An SQS body as an SES bounce or complaint that suppresses its addresses;
 * 'ignored' for a well-formed event that suppresses nothing (a transient or
 * undetermined bounce); null for anything that isn't an SES event.
 */
export function parseMailEvent(body: string): MailEvent | 'ignored' | null {
	if (body.length > MAX_EVENT_BYTES) return null;
	let json: unknown;
	try {
		json = JSON.parse(body);
	} catch {
		return null;
	}
	if (Kind('Bounce').safeParse(json).success) {
		const b = SesBounce.safeParse(json);
		if (!b.success) return null;
		// Permanent: the address doesn't exist or never will take mail. SES
		// puts it on the suppression list for these only (and complaints).
		if (b.data.bounce.bounceType !== 'Permanent') return 'ignored';
		return { reason: 'bounce', addresses: b.data.bounce.bouncedRecipients.map((r) => r.emailAddress), sentAt: b.data.mail?.timestamp ?? null };
	}
	if (!Kind('Complaint').safeParse(json).success) return null;
	const c = SesComplaint.safeParse(json);
	if (!c.success) return null;
	return { reason: 'complaint', addresses: c.data.complaint.complainedRecipients.map((r) => r.emailAddress), sentAt: c.data.mail?.timestamp ?? null };
}

/** SES writes a recipient as it was on the envelope, possibly `Name <a@b>`: the bare address. */
export function bareAddress(s: string): string {
	const m = /<([^<>\s]+@[^<>\s]+)>\s*$/.exec(s);
	return (m ? m[1]! : s).trim();
}

export interface MailEventOutcome {
	reason: SuppressionReason;
	/** People newly flagged (an unknown, already flagged or stale address counts 0). */
	suppressed: number;
}

/** Apply a parsed event, in the worker's own context (app_mail_suppress). */
export async function applyMailEvent(e: MailEvent): Promise<MailEventOutcome> {
	let suppressed = 0;
	for (const a of e.addresses) {
		const { rows } = await withoutUser((db) => db.query<{ n: number }>('SELECT app_mail_suppress($1, $2, $3) AS n', [bareAddress(a), e.reason, e.sentAt]));
		suppressed += rows[0]?.n ?? 0;
	}
	return { reason: e.reason, suppressed };
}

/**
 * An SQS body from the mail-events queue: parsed, then applied. Returns what
 * happened, for the log line (never the addresses). A database error throws,
 * so the batch is retried (and dead-lettered after 5 receives).
 */
export async function acceptMailEvent(body: string): Promise<MailEventOutcome | 'ignored' | 'invalid'> {
	const e = parseMailEvent(body);
	if (e === null) return 'invalid';
	if (e === 'ignored') return 'ignored';
	return applyMailEvent(e);
}

/**
 * Take an address off SES's account-level suppression list, so the mail the
 * person just turned back on is delivered (MAIL_TRANSPORT=ses only; every
 * other transport has no list). An address SES doesn't list is fine.
 */
export async function releaseAddress(email: string): Promise<void> {
	if ((process.env.MAIL_TRANSPORT || 'log') !== 'ses') return;
	const { SESv2Client, DeleteSuppressedDestinationCommand, NotFoundException } = await import('@aws-sdk/client-sesv2');
	const client = new SESv2Client(process.env.SES_REGION ? { region: process.env.SES_REGION } : {});
	try {
		await client.send(new DeleteSuppressedDestinationCommand({ EmailAddress: email }));
	} catch (err) {
		if (err instanceof NotFoundException) return;
		throw err;
	}
}
