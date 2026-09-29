// The dam page (docs/design/farmer-view.md §3 Q3, §6.3, board 3). Pure
// wording, from the message catalogue ($lib/i18n, WP-2.5).
import type { FarmProjection } from '@water-management/engine';
import { msg, t } from '$lib/i18n/locale.svelte';
import type { Rich } from '$lib/i18n/rich';
import { damCard, daysLeftLine, noStopLevel } from './cards';
import { count, DAYS, daysBetween, fmtDay, fmtDayMonth, fmtMonthShort, fmtMonthYear, fmtPct, fmtVolume, joinAnd, type VolumeUnit } from './format';

export interface DamPageVm {
	pct: string;
	/** "full on 10 Jan". */
	asOf: string;
	barPct: number;
	stopPct: number | null;
	stopLabel: string | null;
	facts: { label: string; value: string }[];
	/** What "You can still use" means; null without a stop level. */
	usableNote: string | null;
	daysLeft: Rich | null;
	noStop: string | null;
	/** Under the 12-month line. */
	chartCaption: string;
}

/** "up 32.4 ML", "down 5 000 m³", "no change": the storage change over 30 days. */
export function storageChange(farm: FarmProjection, unit: VolumeUnit): string {
	const d = farm.dam!;
	// The two storages when the view has them (engine ≥ 1.27.0: exact when the dam's capacity changed); else from the levels.
	const m3 = d.storage30dAgoM3 !== undefined ? d.storageM3 - d.storage30dAgoM3 : (d.pct - d.pct30dAgo) * farm.damCapacityM3;
	// i18n-section: farm.damPage
	if (Math.abs(m3) < 0.5) return t('no change');
	return t(m3 > 0 ? 'up {amount}' : 'down {amount}', { amount: fmtVolume(Math.abs(m3), unit) });
}

/** "27 Jul 2023", or "not in the last 12 months". */
export function lastSpillText(farm: FarmProjection): string {
	const s = farm.dam?.lastSpill;
	if (!s || daysBetween(s, farm.dataUntil) > 365) return t('not in the last 12 months');
	return fmtDay(s);
}

/** null for a farm with no dam (no dam page: the page says so and links back). */
export function damPage(farm: FarmProjection, unit: VolumeUnit, staleEnd: string | null = null): DamPageVm | null {
	const card = damCard(farm, unit);
	const d = farm.dam;
	if (!card || !d) return null;
	const facts = [
		{ label: t('Water in the dam'), value: fmtVolume(d.storageM3, unit) },
		{ label: t('Full'), value: fmtVolume(farm.damCapacityM3, unit) }
	];
	if (d.usableM3 != null && farm.damMinPct > 0) facts.push({ label: t('You can still use'), value: fmtVolume(d.usableM3, unit) });
	// The 30 days to the figures' last day: "Last 30 days" only while they are current (cards.ts staleUntil).
	facts.push({ label: staleEnd ? t('30 days to {date}', { date: fmtDay(staleEnd) }) : t('Last 30 days'), value: storageChange(farm, unit) });
	facts.push({
		label: t('Same day last season'),
		value: farm.lastSeason?.damPct != null ? fmtPct(farm.lastSeason.damPct) : t('not available')
	});
	facts.push({ label: t('Last full and spilling'), value: lastSpillText(farm) });

	const first = farm.monthly[0]?.month;
	const last = farm.monthly[farm.monthly.length - 1]?.month;
	const caption: string[] = [];
	if (first && last) caption.push(t('{from} to {to}, end of each month.', { from: fmtMonthYear(first), to: fmtMonthYear(last) }));
	if (card.stopPct != null) caption.push(t('Dashed line: irrigation stops ({pct}).', { pct: fmtPct(farm.damMinPct) }));
	const s = farm.season;
	if (s.shortDays > 0) {
		const months = joinAnd(s.shortMonths.map(fmtMonthShort));
		const atLine = card.stopPct != null && s.shortDaysAtStopLevel >= s.shortDays;
		const words = months
			? atLine
				? msg('You were short on {days} in {months}, while the dam sat at that line.')
				: msg('You were short on {days} in {months}.')
			: atLine
				? msg('You were short on {days}, while the dam sat at that line.')
				: msg('You were short on {days}.');
		caption.push(t(words, { days: count(DAYS, s.shortDays), months }));
	}
	return {
		pct: card.pct,
		asOf: t('full on {date}', { date: fmtDayMonth(farm.dataUntil) }),
		barPct: card.barPct,
		stopPct: card.stopPct,
		stopLabel: card.stopLabel,
		facts,
		usableNote: card.stopPct != null ? t('“You can still use” is the water above the level where irrigation stops (your pump intake or reserve).') : null,
		daysLeft: daysLeftLine(farm, unit, true),
		noStop: card.stopPct == null ? noStopLevel() : null,
		chartCaption: caption.join(' ')
	};
}

/** "Where these figures come from", two paragraphs. */
export const damSource = () => [t('Nobody measures your dam for this. The model works the level out every day from rain, the river flowing in, and the water your crops need.'), t('If your gauge plate reads very differently, or your pump stops at another level, tell your WUA. It helps them correct the model.')];
