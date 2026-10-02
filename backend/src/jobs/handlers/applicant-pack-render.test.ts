// The applicant_pack_render handler's decisions (165_applicant_copy;
// docs/evidence-pack.md § Applicants), with the database, browser, storage
// and queue stubbed. The route, the token and the render session run against
// Postgres in evidence/applicant-copy.db.test.ts.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { calls } = vi.hoisted(() => ({
	calls: { sent: [] as unknown[], tokens: [] as { projectId: string; packId: string }[], enqueued: [] as Record<string, unknown>[], puts: [] as { key: string; sha256: string }[] }
}));
const renderReportPdf = vi.fn();
vi.mock('../../reports/render.js', async (orig) => ({ ...(await orig<typeof import('../../reports/render.js')>()), renderReportPdf: (...a: unknown[]) => renderReportPdf(...a) }));
const headPackPdf = vi.fn(async (_key: string, _sha256: string): Promise<{ ok: boolean; reason?: string }> => ({ ok: true }));
vi.mock('../../reports/storage.js', async (orig) => ({
	...(await orig<typeof import('../../reports/storage.js')>()),
	putPackPdf: async (key: string, _b: Uint8Array, sha256: string) => void calls.puts.push({ key, sha256 }),
	headPackPdf: (k: string, h: string) => headPackPdf(k, h)
}));
vi.mock('../../reports/tokens.js', () => ({
	issueApplicantPackRenderToken: async (_db: unknown, projectId: string, packId: string) => (calls.tokens.push({ projectId, packId }), 'T'.repeat(43))
}));
vi.mock('../../db/tx.js', () => ({ withUser: async (_u: string, fn: (db: unknown) => unknown) => fn({}) }));
vi.mock('../transport.js', async (orig) => ({
	...(await orig<typeof import('../transport.js')>()),
	sendToQueue: async (_url: string | undefined, _name: string, message: unknown) => void calls.sent.push(message)
}));
vi.mock('../queue.js', () => ({ enqueueJob: async (_db: unknown, j: Record<string, unknown>) => (calls.enqueued.push(j), { job: { id: 'j2' }, created: true }) }));

const { applicantPackRenderHandler } = await import('./applicant-pack-render.js');
const { JobError } = await import('../errors.js');

const P = '00000000-0000-4000-8000-000000000002';
const K = '00000000-0000-4000-8000-000000000006';
const S = '00000000-0000-4000-8000-000000000007';
const job = { id: 'j1', projectId: P, kind: 'applicant_pack_render' as const, actingUserId: 'u1', leaseToken: 'l', attempts: 1, maxAttempts: 3 };
const bytes = Buffer.from("%PDF-1.7 an applicant's copy");
const SHA = createHash('sha256').update(bytes).digest('hex');

/** A database where the caller is (or isn't) a party of the pack's application, and a copy is (or isn't) recorded. */
function db(o: { party?: boolean; recordedAlready?: boolean } = {}) {
	const queries: { sql: string; params: unknown[] }[] = [];
	return {
		queries,
		async query(sql: string, params: unknown[] = []) {
			queries.push({ sql, params });
			if (sql.includes('app_applicant_pack_meta')) return { rows: [{ m: o.party === false ? null : { scenarioId: S } }] };
			if (sql.includes('FROM evidence_pack_applicant_copy')) return { rows: o.recordedAlready ? [{}] : [] };
			if (sql.includes('app_record_applicant_pack_pdf')) return { rows: [{ recorded: true }] };
			if (sql.includes('count(*)')) return { rows: [{ n: 1 }] };
			throw new Error(`unexpected query: ${sql}`);
		}
	};
}
const run = (d: ReturnType<typeof db>, payload: Record<string, unknown> = { packId: K }) =>
	applicantPackRenderHandler.run({ db: d as never, job, payload: applicantPackRenderHandler.payload.parse(payload), progress: async () => true });
const recorded = (d: ReturnType<typeof db>) => d.queries.filter((q) => q.sql.includes('app_record_applicant_pack_pdf')).map((q) => q.params);

afterEach(() => {
	calls.sent.length = 0;
	calls.tokens.length = 0;
	calls.enqueued.length = 0;
	calls.puts.length = 0;
	renderReportPdf.mockReset();
	headPackPdf.mockClear();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe('applicant_pack_render', () => {
	it("prints the party's own page of the pack, stores it under applicant/ and records its own hash", async () => {
		vi.spyOn(console, 'info').mockImplementation(() => {});
		renderReportPdf.mockResolvedValueOnce({ pdf: bytes, pages: 3, ms: 500 });
		const d = db();
		await run(d);
		expect(calls.tokens).toEqual([{ projectId: P, packId: K }]);
		expect(renderReportPdf).toHaveBeenCalledWith({ projectId: P, packId: K, scenarioId: S, token: 'T'.repeat(43) }, expect.anything());
		expect(calls.puts).toEqual([{ key: `packs/${P}/${K}/applicant/${SHA}.pdf`, sha256: SHA }]);
		expect(recorded(d)).toEqual([[K, SHA, 3]]);
	});

	it('prints nothing for someone no longer a party, nor again once a copy is recorded', async () => {
		await expect(run(db({ party: false }))).rejects.toBeInstanceOf(JobError);
		await run(db({ recordedAlready: true }));
		expect(renderReportPdf).not.toHaveBeenCalled();
		expect(calls.tokens).toEqual([]);
	});

	it('in production, asks the renderer with the application named, then records its answer once the bucket is seen to hold it', async () => {
		vi.stubEnv('REPORT_RENDERER', 'sqs');
		vi.stubEnv('RENDER_REQUESTS_QUEUE_URL', 'https://sqs.example/render-requests');
		await run(db());
		expect(calls.sent).toEqual([{ v: 1, type: 'render_pack', packId: K, projectId: P, scenarioId: S, token: 'T'.repeat(43) }]);
		vi.spyOn(console, 'info').mockImplementation(() => {});
		const d = db();
		await run(d, { packId: K, result: { ok: true, pages: 3, bytes: bytes.length, ms: 500, sha256: SHA } });
		expect(headPackPdf).toHaveBeenCalledWith(`packs/${P}/${K}/applicant/${SHA}.pdf`, SHA);
		expect(recorded(d)).toEqual([[K, SHA, 3]]);
		// A bucket that doesn't hold it: nothing recorded.
		headPackPdf.mockResolvedValueOnce({ ok: false, reason: 'missing' });
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const d2 = db();
		await expect(run(d2, { packId: K, result: { ok: true, pages: 3, bytes: 1, ms: 1, sha256: SHA } })).rejects.toBeInstanceOf(JobError);
		expect(recorded(d2)).toEqual([]);
		// A retryable failure asks again, delayed.
		await run(db(), { packId: K, result: { ok: false, error: 'timed out', retry: true } });
		expect(calls.enqueued).toEqual([expect.objectContaining({ kind: 'applicant_pack_render', payload: { packId: K }, dedupeKey: `applicant_copy_retry:${K}:u1:1` })]);
	});
});
