import { describe, expect, it } from 'vitest';
import type { Scenario } from '$lib/api/types';
import { sortApplications } from './applications';

const app = (id: string, status: Scenario['status'], submittedAt: string | null, name = id): Scenario =>
	({ id, name, status, submittedAt, updatedAt: '2026-01-01T00:00:00.000Z' }) as Scenario;

const items = [
	app('a', 'decided', '2026-03-01T08:00:00.000Z'),
	app('b', 'submitted', '2026-04-01T08:00:00.000Z'),
	app('c', 'submitted', '2026-02-01T08:00:00.000Z'),
	app('d', 'withdrawn', '2026-05-01T08:00:00.000Z')
];

describe('sortApplications', () => {
	it('by date: newest submission first', () => {
		expect(sortApplications(items, 'date').map((a) => a.id)).toEqual(['d', 'b', 'a', 'c']);
	});

	it('by status: the queue awaiting a decision first, longest-waiting on top', () => {
		expect(sortApplications(items, 'status').map((a) => a.id)).toEqual(['c', 'b', 'd', 'a']);
	});

	it('leaves the input alone and breaks ties by name', () => {
		const same = [app('y', 'submitted', '2026-02-01T08:00:00.000Z', 'Zulu'), app('x', 'submitted', '2026-02-01T08:00:00.000Z', 'Alpha')];
		expect(sortApplications(same, 'date').map((a) => a.name)).toEqual(['Alpha', 'Zulu']);
		expect(same.map((a) => a.id)).toEqual(['y', 'x']);
	});
});
