// What a null day does in a merge (series/merge.ts mergeInto). A person's
// merge (POST /projects/:id/series/merge, the upload form) keeps the stored
// value: a blank day in a file never erases, decided under the row lock, so a
// client never has to fill blanks from values it read earlier. The ingest API
// keeps its documented contract: a null clears the day.
import { describe, expect, it } from 'vitest';
import { app, signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;

const flow = (startDate: string, values: (number | null)[], unit = 'm³/s') => ({ kind: 'flow_observed_m3s', unit, startDate, values });

async function values(u: User, projectId: string): Promise<(number | null)[]> {
	const list = (await u.call('GET', `/projects/${projectId}/series`)).body.series as { id: string }[];
	return (await u.call('GET', `/projects/${projectId}/series/${list[0]!.id}`)).body.values;
}

describe('a null day in a merge', () => {
	it("keeps the stored value in a person's merge, and overwrites where the file has a value", async () => {
		const u = await signUp('Mergenull');
		const p = (await u.call('POST', '/projects', { name: 'Merge nulls' })).body.project.id as string;
		expect((await u.call('PUT', `/projects/${p}/series`, flow('2021-10-01', [1.2, 0.8, 0.6]))).status).toBe(200);
		// l/s, as the form sends a file in l/s: 10-02 is blank, 10-03 corrected, 10-04 new.
		const res = await u.call('POST', `/projects/${p}/series/merge`, flow('2021-10-02', [null, 650, 500], 'l/s'));
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect((await values(u, p)).map((v) => (v === null ? null : Math.round(v * 1e6) / 1e6))).toEqual([1.2, 0.8, 0.65, 0.5]);
		// The history counts the two days that changed, not the blank one, and keeps a revision to restore.
		const h = (await u.call('GET', `/projects/${p}/history?kind=series.merged`)).body.items as { subject: { daysChanged: number; revisionId?: string } }[];
		expect(h[0]!.subject.daysChanged).toBe(2);
		expect(h[0]!.subject.revisionId).toBeTruthy();
	});

	it('clears the day through the ingest API, as documented', async () => {
		const u = await signUp('Ingestnull');
		const p = (await u.call('POST', '/projects', { name: 'Ingest nulls' })).body.project.id as string;
		expect((await u.call('PUT', `/projects/${p}/series`, flow('2021-10-01', [1.2, 0.8]))).status).toBe(200);
		const secret = (await u.call('POST', `/projects/${p}/api-keys`, { name: 'Logger' })).body.secret as string;
		const r = await app.request('/ingest/v1/series/merge', {
			method: 'POST',
			headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
			body: JSON.stringify({ ...flow('2021-10-02', [null]), name: '' })
		});
		expect(r.status).toBe(200);
		expect(await values(u, p)).toEqual([1.2, null]);
	});
});
