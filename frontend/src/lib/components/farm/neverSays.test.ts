// docs/design/farmer-view.md §5.1, the "Never says" column: none of the
// modeller's words reach a farmer. Every string the view models produce for
// the Vaalbank fixture and its variants is scanned. "What this is not" is
// left out on purpose: it names an allocation to say this isn't one; so is
// registeredNote(), which names an entitlement to say a registration isn't
// one (issue #72's fact-check wording).
import { describe, expect, it } from 'vitest';
import type { FarmView } from '@water-management/engine';
import * as cards from './cards';
import * as chart from './chart';
import * as dam from './dam';
import * as notice from './farmNotice';
import { forecastCard } from './forecastCard';
import { vaalbankFixture } from './fixture';
import * as why from './why';

const NEVER = /\b(gain|entitlement|allocation|target|EWR|shortfall|charged?|attribution|binding|natural|simulated|consumptive|equitable|you may take)\b/i;

function strings(x: unknown, out: string[] = []): string[] {
	if (typeof x === 'string') out.push(x);
	else if (Array.isArray(x)) x.forEach((y) => strings(y, out));
	else if (x && typeof x === 'object') Object.values(x).forEach((y) => strings(y, out));
	return out;
}

function everything(v: FarmView): string[] {
	const f = v.farm;
	return strings([
		cards.datesLine(v, '2024-02-01'),
		cards.noticeCard(v),
		cards.supplyCard(f, 'm3'),
		cards.supplyCard(f, 'ML'),
		cards.damCard(f, 'ML'),
		cards.lookingBack(f),
		cards.compareCard(f),
		cards.positionLine(v),
		cards.outletLine(v),
		cards.whoCanSee(),
		cards.privacy(),
		cards.disclaimer(),
		notice.farmNoticeTitle(),
		notice.farmNoticePoints(),
		cards.farmSummaryLine(f),
		why.whyTitle(f),
		why.whyIntro(f),
		why.step1(f),
		why.step2(f),
		why.step3(f),
		why.wuaDecided(v),
		dam.damPage(f, 'ML'),
		dam.damSource(),
		chart.supplySummary(f.monthly, f.dataUntil),
		chart.damSummary(f.monthly, f.dataUntil),
		forecastCard(f, '2024-01-20'),
		cards.registeredCard(v, 'ML')
	]);
}

const variants: [string, (v: FarmView) => void][] = [
	['as published', () => {}],
	['no stop level', (v) => ((v.farm.damMinPct = 0), (v.farm.dam!.usableM3 = null), (v.farm.dam!.usableDays = null))],
	['below k', (v) => ((v.farm.river.equitableFraction = null), (v.farm.river.aboveBelowShareM3Day = null))],
	['above the share, beyond it', (v) => ((v.farm.river.aboveBelowShareM3Day = -50), (v.farm.river.cutBeyondShare = true))],
	['only low rain', (v) => v.farm.river.sites.forEach((s) => (s.daysOnlyNatural = s.daysNotMet))],
	['never asked', (v) => ((v.farm.river.chargedDays = 0), (v.farm.river.sites = []))],
	['no headline', (v) => ((v.farm.river.headline = null), (v.farm.river.band = null), (v.farm.season.fraction = null))],
	['restricted', (v) => (v.publication.restriction = { level: 'restricted', pct: 20, notice: {} })],
	[
		'with a forecast (WP-2.12)',
		(v) =>
			(v.farm.forecast = { from: '2024-01-11', to: '2024-01-24', days: 14, madeOn: '2024-01-11', minDamPct: 0.38, minDamDate: '2024-01-20', deficitDays: 3, suppliedFraction: 0.8 })
	],
	['with registered water (issue #72)', (v) => (v.registered = { asOf: '2024-01-12', surfaceM3PerYear: 400_000, groundwaterM3PerYear: 25_000, storageM3: 300_000 })]
];

describe('the farmer view never uses the modeller’s words', () => {
	for (const [name, patch] of variants) {
		it(name, () => {
			const v = vaalbankFixture();
			patch(v);
			for (const s of everything(v)) expect(s, s).not.toMatch(NEVER);
		});
	}
});
