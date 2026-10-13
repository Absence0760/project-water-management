// A relative day word ("ran today", "published today", the history's "Today"
// heading) is the viewer's clock against a record's server timestamp. A record
// made at 23:59:58 UTC and drawn at 00:00:02 reads "yesterday": CI failed that
// way at 2026-10-13T00:00:05Z. So a spec that asserts one pins the page's clock
// to the record's own stamp, read back from the API, before the page draws it:
// the word is then exact at any hour, never (today|yesterday).
//
// The clock is the browser context's (Playwright's page.clock): Date.now() and
// new Date() return the pinned moment from then on, through reloads, while
// timers keep running. It applies to what is drawn after the pin, so a record
// made through the UI is pinned and then drawn again (a reload, or opening
// the section). A guard (clock.test.ts) holds every spec asserting a day word
// to a pin earlier in its test.
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { API_URL } from './env.ts';

/** Fix the page's clock at `at` (an ISO timestamp the server wrote). */
export async function pinClock(page: Page, at: string | null | undefined): Promise<void> {
	expect(at, 'the record to pin the clock to has a timestamp').toBeTruthy();
	await page.clock.setFixedTime(new Date(at!));
}

async function get<T>(request: APIRequestContext, path: string): Promise<T> {
	const res = await request.get(`${API_URL}${path}`);
	expect(res.status(), `${path} → ${await res.text()}`).toBe(200);
	return (await res.json()) as T;
}

/**
 * Pin the clock to one of the project's own stamps: its newest run
 * (`lastRunAt`) or its current publication (`publishedAt`). `request` is the
 * viewer's, for a page signed in as someone else.
 */
export async function pinClockToProject(page: Page, projectId: string, stamp: 'lastRunAt' | 'publishedAt', request = page.request): Promise<string> {
	const { project } = await get<{ project: Record<typeof stamp, string | null> }>(request, `/projects/${projectId}`);
	await pinClock(page, project[stamp]);
	return project[stamp]!;
}

/** Pin the clock to the project's newest history entry (a revision or an event). */
export async function pinClockToLatestChange(page: Page, projectId: string, request = page.request): Promise<string> {
	const { items } = await get<{ items: { createdAt: string }[] }>(request, `/projects/${projectId}/history?limit=1`);
	await pinClock(page, items[0]?.createdAt);
	return items[0]!.createdAt;
}

/** Pin the clock to when a run's notes were last saved. */
export async function pinClockToRunNotes(page: Page, projectId: string, runId: string, request = page.request): Promise<string> {
	const { runs } = await get<{ runs: { id: string; notesUpdatedAt: string | null }[] }>(request, `/projects/${projectId}/runs`);
	const at = runs.find((r) => r.id === runId)?.notesUpdatedAt;
	await pinClock(page, at);
	return at!;
}
