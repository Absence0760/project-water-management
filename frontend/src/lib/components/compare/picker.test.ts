import { describe, expect, it } from 'vitest';
import type { RunMeta } from '$lib/api/types';
import { compareSearch, defaultPair, defaultRunFor, formatRef, parseRef, runOptionLabel } from './picker';

const run = (id: string, label = ''): RunMeta => ({
	id,
	label,
	engineVersion: '0.2.0',
	startDate: '2000-01-01',
	endDate: '2020-12-31',
	createdAt: '2026-09-23T12:00:00Z',
	createdBy: 'A',
	legacy: false
});

describe('run refs', () => {
	it('parses and formats <projectId>:<runId>', () => {
		expect(parseRef('p1:r1')).toEqual({ projectId: 'p1', runId: 'r1' });
		expect(formatRef({ projectId: 'p1', runId: 'r1' })).toBe('p1:r1');
		for (const bad of [null, undefined, '', 'p1', 'p1:', ':r1', 'p1:r1:x']) expect(parseRef(bad)).toBeNull();
	});

	it('builds the page query, ?project= only when no side is chosen', () => {
		const a = { projectId: 'p', runId: 'r1' };
		const b = { projectId: 'q', runId: 'r2' };
		expect(compareSearch(a, b)).toBe('?a=p%3Ar1&b=q%3Ar2');
		expect(compareSearch(a, null, 'p')).toBe('?a=p%3Ar1');
		expect(compareSearch(null, null, 'p')).toBe('?project=p');
		expect(compareSearch(null, null)).toBe('');
	});
});

describe('picker defaults', () => {
	it('opens with A = previous run and B = latest run of the project', () => {
		expect(defaultPair('p', [run('new'), run('old'), run('older')])).toEqual({
			a: { projectId: 'p', runId: 'old' },
			b: { projectId: 'p', runId: 'new' }
		});
	});

	it('has no default pair with fewer than two runs', () => {
		expect(defaultPair('p', [run('only')])).toBeNull();
		expect(defaultPair('p', [])).toBeNull();
	});

	it('switching a side to a project avoids the run chosen on the other side', () => {
		const runs = [run('r3'), run('r2'), run('r1')];
		expect(defaultRunFor(runs, { projectId: 'p', runId: 'r3' }, 'p')).toBe('r2');
		expect(defaultRunFor(runs, { projectId: 'other', runId: 'r3' }, 'p')).toBe('r3');
		expect(defaultRunFor(runs, null, 'p')).toBe('r3');
		expect(defaultRunFor([run('r1')], { projectId: 'p', runId: 'r1' }, 'p')).toBe('r1');
		expect(defaultRunFor([], null, 'p')).toBeNull();
	});

	it('labels runs, falling back to "Untitled run"', () => {
		const fmt = (iso: string) => iso.slice(0, 10);
		expect(runOptionLabel(run('r', 'Baseline'), fmt)).toBe('Baseline · 2026-09-23 · 2000–2020');
		expect(runOptionLabel(run('r'), fmt)).toBe('Untitled run · 2026-09-23 · 2000–2020');
	});

	it('adds the Runs list tags that apply, in its order', () => {
		const fmt = (iso: string) => iso.slice(0, 10);
		const tagged: RunMeta = { ...run('r', 'Dam raise'), evidence: 'current', pinned: true, legacy: true };
		expect(runOptionLabel(tagged, fmt, true)).toBe('Dam raise · 2026-09-23 · 2000–2020 · latest · evidence · pinned · workbook comparison');
		expect(runOptionLabel({ ...run('r', 'Old'), evidence: 'past' }, fmt)).toBe('Old · 2026-09-23 · 2000–2020 · former evidence');
	});
});
