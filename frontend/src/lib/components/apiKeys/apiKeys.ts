// View helpers for ApiKeysPanel (WP-2.9, docs/ui.md § API keys): a key's
// state, the words for its row, and the curl example. Pure, so they are
// unit-tested (apiKeys.test.ts).
import { SERIES_KINDS } from '@water-management/engine';
import type { ApiKey, ApiKeySeries } from '$lib/api/types';
import type { FileFormat } from '$lib/components/common/formatHelp';
import { fmtDate } from '$lib/format/number';
import { kindLabel } from '$lib/series/kinds';

/** How long a new key lives: the choices offered (the API takes any 1–3650 days, or none). */
export const KEY_EXPIRY_CHOICES = [
	{ days: 0, label: 'Until revoked' },
	{ days: 90, label: '90 days' },
	{ days: 365, label: '1 year' },
	{ days: 730, label: '2 years' }
] as const;
export const DEFAULT_KEY_EXPIRY_DAYS = 0;

export type KeyState = 'live' | 'expired' | 'revoked';

export function keyState(key: Pick<ApiKey, 'expiresAt' | 'revokedAt'>, now: number = Date.now()): KeyState {
	if (key.revokedAt) return 'revoked';
	return key.expiresAt !== null && Date.parse(key.expiresAt) <= now ? 'expired' : 'live';
}

export const KEY_STATE_WORD: Record<KeyState, string> = { live: 'Live', expired: 'Expired', revoked: 'Revoked' };

/** "Flow — logger “Weir”", or the kind alone for an unnamed series. */
export const seriesText = (s: ApiKeySeries) => (s.name ? `${kindLabel(s.kind)} “${s.name}”` : kindLabel(s.kind));

export interface KeyRow {
	id: string;
	name: string;
	/** `wm_3f2a9c1e_…`: enough to tell keys apart, never the secret. */
	shown: string;
	state: KeyState;
	/** "Any series", or the listed ones. */
	series: string;
	/** "2026-09-25 by Jo Owner". */
	created: string;
	/** "Never", a date, or "Revoked 2026-09-26 by Jo Owner". */
	ends: string;
	/** "2026-09-25 14:05", or "Never". */
	lastUsed: string;
	canRevoke: boolean;
}

/** One row of the list, in the viewer's own time zone. */
export function keyRow(key: ApiKey, now: number = Date.now()): KeyRow {
	const state = keyState(key, now);
	const by = (name: string | null) => (name ? ` by ${name}` : '');
	return {
		id: key.id,
		name: key.name,
		shown: `wm_${key.prefix}_…`,
		state,
		series: key.allowedSeries === null ? 'Any series' : key.allowedSeries.map(seriesText).join(', '),
		created: `${fmtDate(key.createdAt)}${by(key.createdBy)}`,
		ends: state === 'revoked' ? `Revoked ${fmtDate(key.revokedAt)}${by(key.revokedBy)}` : key.expiresAt === null ? 'Never' : fmtDate(key.expiresAt),
		lastUsed: key.lastUsedAt ? fmtDate(key.lastUsedAt, true) : 'Never',
		canRevoke: state === 'live'
	};
}

/** Live keys first (newest first, as the API lists them), then the rest. */
export function sortKeys(keys: readonly ApiKey[], now: number = Date.now()): ApiKey[] {
	const live = keys.filter((k) => keyState(k, now) === 'live');
	return [...live, ...keys.filter((k) => keyState(k, now) !== 'live')];
}

/** The confirm before a revoke. */
export const revokeKeyQuestion = (name: string) =>
	`Revoke the API key “${name}”? Anything still sending data with it is refused from its next request. This can’t be undone.`;

/**
 * The API's base for a curl command: an absolute PUBLIC_API_URL as it is
 * (dev), a relative one (production's `/api`) against the page's origin.
 */
export function apiBase(publicApiUrl: string, origin: string): string {
	const base = /^https?:\/\//.test(publicApiUrl) ? publicApiUrl : `${origin}${publicApiUrl.startsWith('/') ? '' : '/'}${publicApiUrl}`;
	return base.replace(/\/+$/, '');
}

/** A copyable curl that pushes one day, with a placeholder where the key goes (never a real key). */
/**
 * The ingest body the panel's "Expected format" shows (issue #456; docs/api.md
 * § Ingest): three invented days of rain from 1 April 2025, the third with no
 * reading.
 */
export const INGEST_EXAMPLE_BODY = JSON.stringify(
	{ kind: 'rain_catchment_mm', name: 'Logger', unit: 'mm', startDate: '2025-04-01', values: [0, 12.4, null], source: 'weir gateway' },
	null,
	2
);

/** The panel's Expected format of a request (issue #456; the File formats help page, issue #477). */
export const INGEST_FORMAT: FileFormat = {
	id: 'ingest-request',
	title: 'Logger readings sent with an API key',
	where: 'Settings & calibration → API keys',
	accepts: 'JSON (Content-Type: application/json), sent with POST to /ingest/v1/series/merge with the key as Authorization: Bearer <key>.',
	rules: [
		`\`kind\`: one of ${SERIES_KINDS.map((k) => `\`${k}\``).join(', ')}.`,
		'`name`: the series’ name, as the Data page shows it. A key limited to some series writes only those. A name the project doesn’t have yet makes a new series only while the project has no outlet series of that kind; otherwise add the series on the Data page first (the request is answered 409).',
		'`unit`: flow in m3/s, l/s, m3/day, m3/h or ML/day; rain and evaporation in mm, cm or in. The values are converted to m³/s or mm when stored.',
		'`startDate` (YYYY-MM-DD) and `values`, one a day from that date. Only the days sent are touched: new ones are added, changed ones corrected, and a `null` clears its day (unlike an upload’s Append / update, which keeps the stored value).',
		'Optional: `source`, a label of up to 100 characters kept in History.',
		'A body the server can’t take is answered 400, and its `details` name each problem’s place in the body (`["values", 3]`); nothing is written.'
	],
	example: INGEST_EXAMPLE_BODY,
	files: [{ name: 'ingest-example.json', text: INGEST_EXAMPLE_BODY, type: 'application/json' }]
};

export function curlExample(base: string, series: ApiKeySeries | null, today: string): string {
	const s = series ?? { kind: 'flow_logger_m3s', name: 'Logger' };
	const unit = s.kind.endsWith('_mm') ? 'mm' : 'm3/s';
	const body = JSON.stringify({ kind: s.kind, name: s.name, unit, startDate: today, values: [0.42] });
	return [`curl -X POST ${base}/ingest/v1/series/merge \\`, `  -H "Authorization: Bearer $WM_INGEST_KEY" \\`, `  -H "Content-Type: application/json" \\`, `  -d '${body}'`].join('\n');
}
