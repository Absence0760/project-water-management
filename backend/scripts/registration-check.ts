// Record a check of a signer's professional registration against the public
// SACNASP or ECSA register (165_signers; docs/evidence-pack.md § Signing →
// The registration check; docs/deployment.md § Runbooks):
//
//   pnpm import:registration-check --email <signer> --body sacnasp|ecsa --category <code> --number "<no>"
//       --register-name "<name as the register shows it>" --org "<who checked: the host organisation>"
//       [--checked-at YYYY-MM-DD] [--not-registered] [--note "<where, how>"]
//   pnpm import:registration-check --list --email <signer>
//
// The host (the responsible party running the project) looks the signer up on
// the register and tells the operator what it found; the operator records it
// here. The app never records one itself and never shows "checked against
// the register" without such a row; the operator does not check registrations
// on the app's behalf (that would be an assurance the Terms disclaim).
//
// Runs as the schema owner (MIGRATION_DATABASE_URL), like import:quaternaries:
// water_app can't write registration_check. A check is insert-only: record a
// new one to correct or renew it (the latest counts; a check is current for
// 365 days and only while it says `registered`). Issue binds each pack
// sign-off to its signer's current check (app_pack_bind_registration_checks).
import { config } from 'dotenv';
import pg from 'pg';
import { REGISTRATION_BODIES, registrationCategoriesOf } from '@water-management/engine';

export interface CheckArgs {
	mode: 'record';
	email: string;
	body: 'sacnasp' | 'ecsa';
	category: string;
	number: string;
	registerName: string;
	org: string;
	checkedAt: string | null;
	outcome: 'registered' | 'not_registered';
	note: string;
}

export interface ListArgs {
	mode: 'list';
	email: string;
}

export const USAGE =
	'usage: pnpm import:registration-check --email <signer> --body sacnasp|ecsa --category <code> --number "<no>" --register-name "<name>" --org "<host organisation>" [--checked-at YYYY-MM-DD] [--not-registered] [--note "<text>"]\n' +
	'       pnpm import:registration-check --list --email <signer>';

/** The arguments, or why they are wrong. */
export function parseArgs(argv: string[]): CheckArgs | ListArgs | string {
	const flag = (name: string): string | null => {
		const i = argv.indexOf(name);
		return i >= 0 ? (argv[i + 1] ?? '').trim() : null;
	};
	const email = flag('--email');
	if (!email || !email.includes('@')) return 'give the signer’s account email with --email';
	if (argv.includes('--list')) return { mode: 'list', email };
	const body = (flag('--body') ?? '').toLowerCase();
	const known = REGISTRATION_BODIES.find((b) => b.code === body);
	if (!known) return `--body must be one of ${REGISTRATION_BODIES.map((b) => b.code).join(', ')}`;
	const category = flag('--category') ?? '';
	const categories = registrationCategoriesOf(known.code);
	if (!categories.some((c) => c.code === category)) return `--category must be one of ${categories.map((c) => c.code).join(', ')} for ${body}`;
	const number = flag('--number') ?? '';
	if (number.length < 1 || number.length > 50) return 'give the registration number as the register shows it with --number (at most 50 characters)';
	const registerName = flag('--register-name') ?? '';
	if (registerName.length < 1 || registerName.length > 200) return 'give the name as the register shows it with --register-name';
	const org = flag('--org') ?? '';
	if (org.length < 1 || org.length > 200) return 'say who checked (the host organisation) with --org';
	const checkedAt = flag('--checked-at');
	if (checkedAt !== null && !/^\d{4}-\d{2}-\d{2}$/.test(checkedAt)) return '--checked-at is the day the register was consulted, YYYY-MM-DD';
	const note = flag('--note') ?? '';
	if (note.length > 1000) return '--note is at most 1000 characters';
	return {
		mode: 'record',
		email,
		body: known.code as 'sacnasp' | 'ecsa',
		category,
		number,
		registerName,
		org,
		checkedAt,
		outcome: argv.includes('--not-registered') ? 'not_registered' : 'registered',
		note
	};
}

/** Record one check (or list a person's) in the database at `url`; returns the lines to print. */
export async function runRegistrationCheck(url: string, args: CheckArgs | ListArgs): Promise<{ ok: boolean; lines: string[] }> {
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		const { rows: users } = await client.query<{ id: string; display_name: string }>('SELECT id, display_name FROM app_user WHERE email = $1', [args.email]);
		const user = users[0];
		if (!user) return { ok: false, lines: [`no account with the email ${args.email}`] };
		if (args.mode === 'list') {
			const { rows } = await client.query<Record<string, unknown>>(
				`SELECT registration_body, registration_category, registration_no, register_name, outcome, checked_by_org,
					to_char(checked_at, 'YYYY-MM-DD') AS checked_on, note
				 FROM registration_check WHERE user_id = $1 ORDER BY checked_at DESC, id DESC`,
				[user.id]
			);
			if (!rows.length) return { ok: true, lines: [`${user.display_name}: no registration check recorded`] };
			return {
				ok: true,
				lines: rows.map(
					(r) =>
						`${String(r.checked_on)}  ${String(r.registration_body)} ${String(r.registration_category)} ${String(r.registration_no)}  ${String(r.outcome)}  "${String(r.register_name)}", checked by ${String(r.checked_by_org)}${r.note ? ` (${String(r.note)})` : ''}`
				)
			};
		}
		const { rows } = await client.query<{ id: string }>(
			`INSERT INTO registration_check (user_id, registration_body, registration_category, registration_no, register_name, outcome, checked_by_org, checked_at, note)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, coalesce($8::date::timestamptz, now()), $9) RETURNING id`,
			[user.id, args.body, args.category, args.number, args.registerName, args.outcome, args.org, args.checkedAt, args.note]
		);
		return {
			ok: true,
			lines: [
				`recorded check ${rows[0]!.id}: ${user.display_name} (${args.email}), ${args.body} ${args.category} ${args.number}, ${args.outcome}, checked by ${args.org}`,
				args.outcome === 'registered'
					? 'their sign-offs with exactly this registration count as checked for 365 days; a pack issued in that time binds this check'
					: 'their sign-offs with this registration are no longer checked: a pack they sign as specialist can’t be issued'
			]
		};
	} finally {
		await client.end();
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	config({ path: ['.env.development.local', '.env.development'] });
	const url = process.env.MIGRATION_DATABASE_URL;
	const args = parseArgs(process.argv.slice(2));
	if (!url) {
		console.error('MIGRATION_DATABASE_URL is not set');
		process.exit(1);
	}
	if (typeof args === 'string') {
		console.error(`${args}\n${USAGE}`);
		process.exit(2);
	}
	runRegistrationCheck(url, args)
		.then(({ ok, lines }) => {
			for (const l of lines) (ok ? console.log : console.error)(l);
			process.exit(ok ? 0 : 1);
		})
		.catch((err: unknown) => {
			console.error(err instanceof Error ? err.message : err);
			process.exit(1);
		});
}
