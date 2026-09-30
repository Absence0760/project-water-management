// Every word on the /share page's evidence pack view (WP-3.15, the pack half;
// 128_pack_share_notes; docs/ui.md § Share page), as pure functions of POST
// /share/pack's answer. The page lays these out; pack.test.ts pins them.
//
// What the link shows is what the verify page already shows (the pack's
// standing, its hashes and signers) and, while the pack stands (issued), a
// redacted projection of its own frozen report: the Reserve at each EWR site,
// the river's rows of page 1's change table, and the paired change by month.
// A withdrawn or superseded pack shows why it no longer stands, never its
// figures. The report's own English labels stay in the pack; the rows are
// worded here, by their id, so the page reads in the reader's language.
import type { SharedBand, SharePack, SharedPackRow, SharedPackSite } from '$lib/api/types';
import { count, fmtMonthLong, fmtNumber, fmtPct, fmtStampDay, MONTHS } from '$lib/components/farm/format';
import { t } from '$lib/i18n/locale.svelte';

// i18n-section: share.pack

/** "Issued on 28 Sep 2026.", or why it no longer stands. */
export function packStatusLine(v: SharePack['verify']): string {
	const when = v.issuedAt ? fmtStampDay(v.issuedAt) : '';
	if (v.status === 'withdrawn') return t('Withdrawn. It was issued on {date}.', { date: when });
	if (v.status === 'superseded') return t('Replaced by a newer version. It was issued on {date}.', { date: when });
	return t('Issued on {date}.', { date: when });
}

/** Why a withdrawn or superseded pack's figures aren't shown; null while it stands. */
export function standingNote(v: SharePack['verify']): string | null {
	if (v.status === 'withdrawn') return t('This evidence pack was withdrawn, so it no longer stands and its figures aren’t shown here.');
	if (v.status === 'superseded') return t('A newer version of this evidence pack replaced it, so it no longer stands and its figures aren’t shown here.');
	return null;
}

/** The short code of the pack that replaced it (the first 12 hex digits of its manifest hash), or null. */
export function successorCode(v: SharePack['verify']): string | null {
	const h = v.successorSha256;
	return h && /^[0-9a-f]{64}$/.test(h) ? h.slice(0, 12).match(/.{4}/g)!.join('-') : null;
}

export interface PackSiteRow {
	/** "At the catchment outlet", "At Sandspruit weir". */
	place: string;
	/** "Met in 83 % of 240 months". */
	base: string;
	/** With the application; null for baseline evidence. */
	withApp: string | null;
	trend: 'same' | 'better' | 'worse';
	/** "2 more months below the Reserve with this application."; null for baseline evidence. */
	change: string | null;
}

function metIn(rate: number | null, months: number | null): string {
	if (rate === null || !months) return t('Not assessed');
	return t('Met in {pct} of {months}', { pct: fmtPct(rate), months: count(MONTHS, months) });
}

/** The Reserve at each EWR site, the outlet first (as the pack orders them). */
export function packSiteRows(river: SharedPackSite[], application: boolean): PackSiteRow[] {
	return river.map((s) => {
		const lost = s.lost ?? 0;
		const gained = s.gained ?? 0;
		const trend = !application ? 'same' : lost > gained ? 'worse' : gained > lost ? 'better' : 'same';
		const net = Math.abs(lost - gained);
		return {
			place: s.isOutlet || !s.name ? t('At the catchment outlet') : t('At {place}', { place: s.name }),
			base: metIn(s.rateA, s.monthsA),
			withApp: application ? metIn(s.rateB, s.monthsA) : null,
			trend,
			change: !application
				? null
				: trend === 'worse'
					? t('{months} more below the Reserve with this application.', { months: count(MONTHS, net) })
					: trend === 'better'
						? t('{months} fewer below the Reserve with this application.', { months: count(MONTHS, net) })
						: t('No change in the months the Reserve is met.')
		};
	});
}

/** A row's measure in the reader's words, by its id (the pack's own label is English). */
export function rowLabel(r: Pick<SharedPackRow, 'id' | 'subject'>): string {
	switch (r.id) {
		case 'reserve':
			return r.subject ? t('Reserve months met at {place}', { place: r.subject }) : t('Reserve months met at the catchment outlet');
		case 'ewrDays':
			return t('Days below the EWR at the outlet');
		case 'noFlowDays':
			return t('Days with no flow at the outlet');
		case 'shortfall':
			return t('Volume short of the EWR at the outlet, whole run');
		case 'outflowMar':
			return t('Mean yearly flow out of the catchment');
	}
}

const UNIT_WORDS: Record<SharedPackRow['id'], (v: number) => string> = {
	reserve: (v) => fmtPct(v / 100),
	ewrDays: (v) => t('{n} days', { n: fmtNumber(v) }),
	noFlowDays: (v) => t('{n} days', { n: fmtNumber(v) }),
	shortfall: (v) => t('{n} million m³', { n: fmtNumber(v, 2, true) }),
	outflowMar: (v) => t('{n} million m³ a year', { n: fmtNumber(v, 2, true) })
};

/** A value in its unit, or a dash when there is none. */
export function rowValue(id: SharedPackRow['id'], v: number | null): string {
	return v === null ? '–' : UNIT_WORDS[id](v);
}

/** A change with its sign ("+2 days", "−5 %"), or a dash. */
export function rowChange(id: SharedPackRow['id'], v: number | null): string {
	if (v === null) return '–';
	const sign = v > 0 ? '+' : v < 0 ? '−' : '';
	// A reserve row's change is in percentage points.
	return id === 'reserve' ? t('{sign}{n} points', { sign, n: fmtNumber(Math.abs(v), 1, true) }) : `${sign}${UNIT_WORDS[id](Math.abs(v))}`;
}

/** "Likely range −3 to +1 (30 model sets)", or null without a band with percentiles. */
export function bandLine(id: SharedPackRow['id'], b: SharedBand | null): string | null {
	if (!b || b.p5 === null || b.p95 === null) return null;
	return t('Likely range {low} to {high} ({n} model sets)', { low: rowChange(id, b.p5), high: rowChange(id, b.p95), n: fmtNumber(b.n ?? 0) });
}

export interface PackMonthRow {
	/** "October". */
	month: string;
	/** "+3 days". */
	change: string;
	/** "Likely range …", or ''. */
	range: string;
}

/** The paired change in days below the outlet EWR, by calendar month, in the pack's (water-year) order. */
export function monthRows(byMonth: NonNullable<SharePack['figures']>['byMonth']): PackMonthRow[] {
	return (byMonth ?? []).map((m) => ({
		month: fmtMonthLong(`2000-${String(m.month).padStart(2, '0')}`),
		change: rowChange('ewrDays', m.run),
		range: bandLine('ewrDays', m.band) ?? ''
	}));
}

/** "Dr A Signer, SACNASP 400123/10": who signed it, as verify shows them. */
export function signerLine(s: SharePack['verify']['signers'][number]): string {
	return t('{name}, {body} {number}', { name: s.fullName, body: s.registrationBody.toUpperCase(), number: s.registrationNo });
}
