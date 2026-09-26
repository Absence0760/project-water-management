// The dam page (docs/design/farmer-view.md §3 Q3, §6.3, board 3). Pure
// wording, from the message catalogue ($lib/i18n, WP-2.5).
import type { FarmProjection } from '@water-management/engine';
import { t } from '$lib/i18n/locale.svelte';
import type { Rich } from '$lib/i18n/rich';
import { damCard, daysLeftLine, noStopLevel } from './cards';
import { count, daysBetween, fmtDay, fmtDayMonth, fmtMonthShort, fmtMonthYear, fmtPct, fmtVolume, joinAnd, type VolumeUnit } from './format';

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
	const m3 = (d.pct - d.pct30dAgo) * farm.damCapacityM3;
	if (Math.abs(m3) < 0.5) return t('farm.damPage.noChange');
	return t(m3 > 0 ? 'farm.damPage.up' : 'farm.damPage.down', { amount: fmtVolume(Math.abs(m3), unit) });
}

/** "27 Jul 2023", or "not in the last 12 months". */
export function lastSpillText(farm: FarmProjection): string {
	const s = farm.dam?.lastSpill;
	if (!s || daysBetween(s, farm.dataUntil) > 365) return t('farm.damPage.noSpill');
	return fmtDay(s);
}

/** null for a farm with no dam (no dam page: the page says so and links back). */
export function damPage(farm: FarmProjection, unit: VolumeUnit): DamPageVm | null {
	const card = damCard(farm, unit);
	const d = farm.dam;
	if (!card || !d) return null;
	const facts = [
		{ label: t('farm.damPage.inDam'), value: fmtVolume(d.storageM3, unit) },
		{ label: t('farm.damPage.capacity'), value: fmtVolume(farm.damCapacityM3, unit) }
	];
	if (d.usableM3 != null && farm.damMinPct > 0) facts.push({ label: t('farm.damPage.usable'), value: fmtVolume(d.usableM3, unit) });
	facts.push({ label: t('farm.damPage.last30'), value: storageChange(farm, unit) });
	facts.push({
		label: t('farm.damPage.lastSeason'),
		value: farm.lastSeason?.damPct != null ? fmtPct(farm.lastSeason.damPct) : t('farm.notAvailable')
	});
	facts.push({ label: t('farm.damPage.lastSpill'), value: lastSpillText(farm) });

	const first = farm.monthly[0]?.month;
	const last = farm.monthly[farm.monthly.length - 1]?.month;
	const caption: string[] = [];
	if (first && last) caption.push(t('farm.damPage.range', { from: fmtMonthYear(first), to: fmtMonthYear(last) }));
	if (card.stopPct != null) caption.push(t('farm.damPage.stopLine', { pct: fmtPct(farm.damMinPct) }));
	const s = farm.season;
	if (s.shortDays > 0) {
		const months = joinAnd(s.shortMonths.map(fmtMonthShort));
		const atLine = card.stopPct != null && s.shortDaysAtStopLevel >= s.shortDays;
		const key = months
			? atLine
				? 'farm.damPage.shortInAtLine'
				: 'farm.damPage.shortIn'
			: atLine
				? 'farm.damPage.shortAtLine'
				: 'farm.damPage.short';
		caption.push(t(key, { days: count('farm.n.day', s.shortDays), months }));
	}
	return {
		pct: card.pct,
		asOf: t('farm.damPage.asOf', { date: fmtDayMonth(farm.dataUntil) }),
		barPct: card.barPct,
		stopPct: card.stopPct,
		stopLabel: card.stopLabel,
		facts,
		usableNote: card.stopPct != null ? t('farm.damPage.usableNote') : null,
		daysLeft: daysLeftLine(farm, unit, true),
		noStop: card.stopPct == null ? noStopLevel() : null,
		chartCaption: caption.join(' ')
	};
}

/** "Where these figures come from", two paragraphs. */
export const damSource = () => [t('farm.damPage.source1'), t('farm.damPage.source2')];
