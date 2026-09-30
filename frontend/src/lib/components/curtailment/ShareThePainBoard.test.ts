// The board's markup (issue #53 R3), rendered to HTML with Svelte's server
// renderer: the two stages, the equal share in the intro, the footnote, a no-demand farm and the other
// water users' senior / junior rows. The browser behaviour is pinned by
// e2e/tests/share-the-pain.spec.ts.
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { EQUITABLE_SHARE_FOOTNOTE, type CurtailmentFarm, type CurtailmentSummary, type CurtailmentUser } from '@water-management/engine';
import ShareThePainBoard from './ShareThePainBoard.svelte';
import CurtailmentTable from './CurtailmentTable.svelte';

const farm = (over: Partial<CurtailmentFarm>): CurtailmentFarm => ({
	nodeId: 'n',
	name: 'Farm',
	demandM3Day: 100,
	suppliedM3Day: 100,
	deficitM3Day: 0,
	fractionSupplied: 1,
	targetM3Day: 100,
	reduceGainM3Day: 0,
	reduceGainLs: 0,
	targetFraction: 1,
	ewrShortfallM3Day: 0,
	totalChangeM3Day: 0,
	totalChangeLs: 0,
	volumeLeftM3Day: 100,
	fractionOfDemandLeft: 1,
	...over
});

const user = (over: Partial<CurtailmentUser>): CurtailmentUser => ({
	nodeId: 'u',
	name: 'User',
	priority: 'senior',
	demandM3Day: 100,
	suppliedM3Day: 100,
	deficitM3Day: 0,
	fractionSupplied: 1,
	returnedM3Day: 0,
	ewrChargeM3Day: 0,
	curtailed: false,
	supplyCutM3Day: 0,
	supplyCutLs: 0,
	uncurtailedChargeM3Day: 0,
	...over
});

const c: CurtailmentSummary = {
	reportStart: '2021-11-01',
	reportEnd: '2021-12-31',
	days: 61,
	equitableFraction: 0.75,
	farms: [
		farm({ nodeId: 'a', name: 'Upper', demandM3Day: 100, suppliedM3Day: 100, targetM3Day: 75, volumeLeftM3Day: 60 }),
		farm({ nodeId: 'b', name: 'Lower', demandM3Day: 100, suppliedM3Day: 50, targetM3Day: 75, volumeLeftM3Day: 75 }),
		farm({
			nodeId: 'z',
			name: 'Dam only',
			demandM3Day: 0,
			suppliedM3Day: 0,
			targetM3Day: 0,
			volumeLeftM3Day: 0,
			fractionSupplied: null,
			fractionOfDemandLeft: null,
			ewrShortfallM3Day: -12,
			ewrChargeIrrigationM3Day: 0,
			ewrChargeStorageM3Day: -12
		})
	],
	otherUsers: [
		user({ nodeId: 't', name: 'Town', demandM3Day: 800, suppliedM3Day: 600, ewrChargeM3Day: -50, uncurtailedChargeM3Day: -50 }),
		user({ nodeId: 'm', name: 'Mill', priority: 'junior', curtailed: true, demandM3Day: 100, suppliedM3Day: 80, ewrChargeM3Day: -20, supplyCutM3Day: -30 })
	],
	totals: {
		demandM3Day: 200,
		suppliedM3Day: 150,
		deficitM3Day: -50,
		targetM3Day: 150,
		reduceGainM3Day: 0,
		reduceGainLs: 0,
		ewrShortfallM3Day: -12,
		totalChangeM3Day: 0,
		volumeLeftM3Day: 135
	}
};

/** The HTML as text, tags stripped and whitespace collapsed. */
const text = (html: string) =>
	html
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/\s+/g, ' ')
		.trim();

/** One table row's text, found by its row header. */
function row(html: string, name: string): string {
	const rows = html.match(/<tr[\s\S]*?<\/tr>/g) ?? [];
	const hit = rows.map(text).find((r) => r.startsWith(name));
	if (!hit) throw new Error(`no row ${name}`);
	return hit;
}

describe('ShareThePainBoard', () => {
	const { body } = render(ShareThePainBoard, { props: { curtailment: c, names: { a: 'Upper (renamed)' }, period: 'Project window' } });

	it('shows the two stages with the farm totals, and no equitable share stage', () => {
		const stages = text(body.match(/<ol[\s\S]*?<\/ol>/)![0]);
		expect(stages).toBe(
			"1 Today 75% of hydrological unit demand supplied (150 of 200 m³/day) 2 EWR met 68% of hydrological unit demand left once each hydrological unit's EWR charge is met (135 m³/day)"
		);
		expect(body).not.toContain('stage-share');
		expect(text(body)).not.toContain('Equitable share');
	});

	it('says the equal share once, in the intro', () => {
		const intro = text(body.match(/<p[^>]*data-testid="share-intro"[\s\S]*?<\/p>/)![0]);
		expect(intro).toContain('At the equitable share every hydrological unit would get the same 75% of its demand * : the same water in total as today, shared equally.');
	});

	it('says there is nothing to share with no farm demand', () => {
		const dry = { ...c, equitableFraction: null, farms: [c.farms[2]!] };
		const { body: b } = render(ShareThePainBoard, { props: { curtailment: dry } });
		expect(text(b)).toContain('No hydrological unit had demand, so there is nothing to share.');
		expect(text(b)).not.toContain('At the equitable share');
	});

	it('says the share is too small to be a % when farm demand is under the floor', () => {
		const tiny = { ...c, equitableFraction: 0.5, farms: [{ ...c.farms[0]!, demandM3Day: 0.001 }] };
		const { body: b } = render(ShareThePainBoard, { props: { curtailment: tiny } });
		expect(text(b)).toContain('too little for the equitable share');
		expect(text(b)).not.toContain('At the equitable share');
		expect(text(b)).not.toContain('the same —');
	});

	it('shows each farm at the two stages, a renamed farm by its current name', () => {
		expect(row(body, 'Group')).toBe('Group Demand m³/day 1. Today supplied, % of demand 2. EWR met left after the EWR charge, % of demand');
		expect(row(body, 'Upper (renamed)')).toBe('Upper (renamed) 100 100% 100 m³/day 60% 60 m³/day');
		expect(row(body, 'Lower')).toBe('Lower 100 50% 50 m³/day 75% 75 m³/day');
		expect(row(body, 'All hydrological units')).toBe('All hydrological units 200 75% 150 m³/day 68% 135 m³/day');
	});

	it('shows a farm with no demand as no demand, with its charge as store less, never a negative demand', () => {
		const r = row(body, 'Dam only');
		expect(r).toBe('Dam only 0 no demand 0 m³/day no demand 0 m³/day store less / pass inflow 12 m³/day');
		// No negative figure anywhere (dates aside).
		expect(text(body)).not.toMatch(/(^|\s)[-−]\d/);
	});

	it('lists the other water users on their own rows, senior or junior, outside the share', () => {
		expect(text(body)).toContain('Other water users (outside the equitable share)');
		expect(row(body, 'Town')).toBe('Town senior, not curtailed 800 75% 600 m³/day 75% 600 m³/day not curtailed: its EWR charge of 50 m³/day stands');
		expect(row(body, 'Mill')).toBe('Mill junior, curtailed 100 80% 80 m³/day 50% 50 m³/day');
		expect(row(body, 'All other users')).toBe('All other users 900 76% 680 m³/day 72% 650 m³/day');
	});

	it('carries the fairness-benchmark footnote', () => {
		expect(text(body)).toContain(`* ${EQUITABLE_SHARE_FOOTNOTE}`);
		expect(body).toContain('id="share-board-footnote"');
		expect(body).toContain('href="#share-board-footnote"');
	});

	it('leaves the users section out when there are none', () => {
		const { body: noUsers } = render(ShareThePainBoard, { props: { curtailment: { ...c, otherUsers: undefined } } });
		expect(text(noUsers)).not.toContain('Other water users');
	});
});

describe('CurtailmentTable with the board', () => {
	const summary = { curtailment: c } as never;
	it('leads with the board under the Curtailment targets heading when asked, and not otherwise (the printable report)', () => {
		const withBoard = render(CurtailmentTable, { props: { summary, board: true } }).body;
		expect(withBoard.indexOf('Curtailment targets')).toBeLessThan(withBoard.indexOf('Share the pain'));
		expect(withBoard.indexOf('Share the pain')).toBeLessThan(withBoard.indexOf('Per hydrological unit'));
		expect(render(CurtailmentTable, { props: { summary } }).body).not.toContain('Share the pain');
	});
	it('shows no board for a run with no farms', () => {
		const body = render(CurtailmentTable, { props: { summary: { curtailment: { ...c, farms: [] } } as never, board: true } }).body;
		expect(body).not.toContain('Share the pain');
	});
});
