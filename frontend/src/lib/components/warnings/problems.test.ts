import { describe, expect, it } from 'vitest';
import { badgeCount, parseSource, problems } from './problems';

describe('problems', () => {
	const inputs = {
		issues: [
			{ area: 'network' as const, message: 'Upper farm drains into itself.', itemId: 'n1' },
			{ area: 'transfers' as const, message: 'A transfer has no source.' }
		],
		blockers: [{ id: 'set-period' as const, label: 'Simulation period', message: 'The simulation period must start before it ends.' }],
		feeds: [{ id: 'f1', name: 'CHIRPS into Rainfall — CHIRPS', message: 'Failing: 3 tries in a row.' }],
		behind: [{ id: 's1', kind: 'rain_catchment_mm', name: '', end: '2026-09-01', age: 40 }],
		runs: [
			{ id: 'r3', label: 'Newest', errata: ['E-4'] },
			{ id: 'r2', label: 'Old', errata: ['E-4'] },
			{ id: 'r1', label: 'Baseline', published: true, errata: ['E-4', 'E-5'] }
		],
		role: 'editor' as const
	};

	it('lists each source’s problems, in order, each with where it is fixed', () => {
		const p = problems(inputs);
		expect(p.map((x) => [x.source, x.title, x.href, x.action])).toEqual([
			['model', 'Network', '?tab=network&edit=n1', 'Go to Network'],
			['model', 'Transfers', '?tab=transfers', 'Go to Transfers'],
			['settings', 'Simulation period', '?tab=settings#set-period', 'Go to Simulation period'],
			['feeds', 'CHIRPS into Rainfall — CHIRPS', '?tab=series#data-feeds', 'Go to Data feeds'],
			['data', 'Rainfall — catchment', '?tab=series&series=s1', 'Go to Data'],
			// The newest and the published runs, not every old one.
			['runs', 'Newest', '?tab=runs&run=r3', 'Go to Runs & results'],
			['runs', 'Baseline (published)', '?tab=runs&run=r1', 'Go to Runs & results']
		]);
		expect(p.find((x) => x.id === 'runs:r1')!.detail).toMatch(/^May be affected by 2 known engine bugs \(E-4, E-5\)/);
		expect(p.find((x) => x.source === 'data')!.detail).toBe('Its last day is 40 days old: runs read nothing newer.');
		expect(new Set(p.map((x) => x.id)).size).toBe(p.length);
	});

	it('gives each a how-to line, an action an editor can take, and an area', () => {
		const p = problems({ ...inputs, feeds: [{ ...inputs.feeds[0]!, enabled: true }] });
		const by = (source: string) => p.find((x) => x.source === source)!;
		expect(by('feeds').fix).toEqual({ kind: 'fetch', label: 'Fetch now', feedId: 'f1' });
		expect(by('runs').fix).toEqual({ kind: 'run', label: 'Run the model' });
		expect(by('data').fix).toEqual({ kind: 'link', label: 'Add newer data', href: '?tab=series&add=data' });
		expect(by('model').fix).toEqual({ kind: 'link', label: 'Go to Network', href: '?tab=network&edit=n1' });
		expect(p.map((x) => x.area)).toEqual(['model', 'model', 'model', 'feeds', 'data', 'runs', 'runs']);
		for (const x of p) expect(x.how).toMatch(/\.$/);
		// A viewer gets the way there, not the action.
		const v = problems({ ...inputs, role: 'viewer', feeds: [{ ...inputs.feeds[0]!, enabled: true }] });
		expect(v.find((x) => x.source === 'feeds')!.fix.kind).toBe('link');
		expect(v.find((x) => x.source === 'runs')!.fix.kind).toBe('link');
	});

		it('gives a viewer no unsaved-settings problems (an edit is an editor’s)', () => {
		expect(problems({ ...inputs, role: 'viewer' }).some((x) => x.source === 'settings')).toBe(false);
	});

	it('counts the badge once the checks are counted, and reads the source filter', () => {
		expect(badgeCount(null, problems(inputs))).toBeNull();
		// The open data checks and run warnings (counted in sources.ts) plus every problem not kept: the Open chip's count.
		expect(badgeCount(3, problems(inputs))).toBe(10);
		expect(badgeCount(3, problems(inputs), new Set(['problem:runs:r3', 'problem:data:s1']))).toBe(8);
		expect(badgeCount(0, [])).toBe(0);
		expect(parseSource('feeds')).toBe('feeds');
		expect(parseSource('nope')).toBe('all');
		expect(parseSource(null)).toBe('all');
	});
});
