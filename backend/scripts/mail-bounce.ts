// Simulate an SES bounce or complaint locally (WP-2.13 follow-up; there is
// no SES on a laptop, so this stands in for the production path
// SES → SNS → the mail-events queue → the worker, mail/suppression.ts):
//
//   pnpm dev:mail:bounce <email>               a permanent bounce
//   pnpm dev:mail:bounce <email> --complaint   a complaint ("this is spam")
//   pnpm dev:mail:bounce <email> --transient   a transient bounce: suppresses nothing
//
// It builds the event SES would publish and runs it through the same
// acceptMailEvent the worker Lambda runs, against the local database
// (DATABASE_URL, as water_app, in the worker's own context). The person with
// that address then sees the banner on their account and alert pages, and
// their alert emails pause until they turn mail back on there.
import { closePool } from '../src/db/pool.js';
import { acceptMailEvent } from '../src/mail/suppression.js';
import { loadDevEnv } from '../src/config/devEnv.js';

/** The SES event-publishing record for one recipient, as the mail-events queue delivers it (SNS raw delivery). */
export function simulatedSesEvent(email: string, kind: 'bounce' | 'complaint' | 'transient', now = new Date()): Record<string, unknown> {
	const timestamp = now.toISOString();
	const mail = {
		timestamp,
		source: 'no-reply@localhost',
		messageId: `local-${now.getTime()}`,
		destination: [email],
		tags: { 'ses:configuration-set': ['local'] }
	};
	if (kind === 'complaint') {
		return { eventType: 'Complaint', mail, complaint: { complainedRecipients: [{ emailAddress: email }], complaintFeedbackType: 'abuse', timestamp, feedbackId: 'local' } };
	}
	return {
		eventType: 'Bounce',
		mail,
		bounce: {
			bounceType: kind === 'transient' ? 'Transient' : 'Permanent',
			bounceSubType: kind === 'transient' ? 'MailboxFull' : 'General',
			bouncedRecipients: [{ emailAddress: email, action: 'failed', status: kind === 'transient' ? '4.2.2' : '5.1.1', diagnosticCode: 'smtp; simulated by pnpm dev:mail:bounce' }],
			timestamp,
			feedbackId: 'local'
		}
	};
}

async function main(argv: string[]): Promise<number> {
	const email = argv.find((a) => !a.startsWith('--'));
	if (!email || !email.includes('@')) {
		console.error('usage: pnpm dev:mail:bounce <email> [--complaint | --transient]');
		return 2;
	}
	const kind = argv.includes('--complaint') ? 'complaint' : argv.includes('--transient') ? 'transient' : 'bounce';
	const outcome = await acceptMailEvent(JSON.stringify(simulatedSesEvent(email, kind)));
	if (outcome === 'ignored') console.log(`${kind} for ${email}: a transient bounce suppresses nothing.`);
	else if (outcome === 'invalid') console.log('the simulated event was refused (a bug in this script).');
	else if (outcome.suppressed) console.log(`${outcome.reason} for ${email}: alert emails paused; the account and alert pages now show the banner.`);
	else console.log(`${outcome.reason} for ${email}: nobody new was flagged (no account with that address, or it is already suppressed).`);
	return outcome === 'invalid' ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	loadDevEnv();
	try {
		process.exitCode = await main(process.argv.slice(2));
	} finally {
		await closePool();
	}
}
