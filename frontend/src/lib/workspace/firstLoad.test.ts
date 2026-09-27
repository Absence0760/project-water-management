import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/api', () => ({ api: {} }));

import { dropProjectPage, projectPageId, startProjectPage, takeProjectPage, type ProjectPageData } from './firstLoad';

const DATA = [{ id: 'p1' }, { nodes: [] }, [], []] as unknown as ProjectPageData;

describe('projectPageId', () => {
	it('is the catchment page only, not its report pages or other routes', () => {
		expect(projectPageId('/projects/abc')).toBe('abc');
		expect(projectPageId('/projects/abc/')).toBe('abc');
		expect(projectPageId('/base/projects/abc', '/base')).toBe('abc');
		expect(projectPageId('/projects/a%20b')).toBe('a b');
		expect(projectPageId('/projects/abc/report')).toBeNull();
		expect(projectPageId('/projects/abc/reports/j1')).toBeNull();
		expect(projectPageId('/projects')).toBeNull();
		expect(projectPageId('/login')).toBeNull();
		expect(projectPageId('/farm/abc')).toBeNull();
		expect(projectPageId('/projects/%E0%A4%A')).toBeNull();
	});
});

describe('startProjectPage / takeProjectPage', () => {
	it('starts the requests on the catchment page and hands them over once', async () => {
		const fetch = vi.fn(async () => DATA);
		startProjectPage('/projects/p1', '', fetch);
		expect(fetch).toHaveBeenCalledWith('p1');
		const taken = takeProjectPage('p1');
		expect(taken).not.toBeNull();
		await expect(taken).resolves.toBe(DATA);
		expect(takeProjectPage('p1')).toBeNull();
	});

	it('starts nothing off the catchment page', () => {
		const fetch = vi.fn(async () => DATA);
		startProjectPage('/teams/t1', '', fetch);
		expect(fetch).not.toHaveBeenCalled();
		expect(takeProjectPage('t1')).toBeNull();
	});

	it('never hands another catchment the requests', () => {
		startProjectPage('/projects/p1', '', async () => DATA);
		expect(takeProjectPage('p2')).toBeNull();
		// …and the unmatched requests are gone, not kept for a later visit.
		expect(takeProjectPage('p1')).toBeNull();
	});

	it('forgets the requests when /auth/me fails', () => {
		startProjectPage('/projects/p1', '', async () => DATA);
		dropProjectPage();
		expect(takeProjectPage('p1')).toBeNull();
	});

	it('a failed request nobody takes is not an unhandled rejection, and the taker still sees it', async () => {
		const unhandled = vi.fn();
		process.on('unhandledRejection', unhandled);
		try {
			startProjectPage('/projects/p1', '', () => Promise.reject(new Error('401')));
			await new Promise((r) => setTimeout(r, 0));
			expect(unhandled).not.toHaveBeenCalled();
			await expect(takeProjectPage('p1')).rejects.toThrow('401');
		} finally {
			process.off('unhandledRejection', unhandled);
		}
	});
});
