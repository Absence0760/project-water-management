// The import worker's protocol (protocol.ts, messages.ts) and its page-side
// client (runner.ts), without a real Worker: handle() driven with the real
// reader and extractor on the committed synthetic workbook, and the runner
// against a fake worker that answers through handle().
import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { InvalidImportOptionsError, InvalidWorkbookError, NotB023WorkbookError, UnreadableWorkbookError, UnsupportedVersionError, WorkbookTooLargeError } from './errors';
import { extractProject } from './extract';
import { type FromWorker, type ToWorker, toFailure } from './messages';
import { readNodeCropWorkbook } from './nodeCrops';
import { handle, type WorkerDeps, type WorkerState } from './protocol';
import { WorkbookImportCancelled, WorkbookImportFailed, createWorkbookImport, type WorkerLike } from './runner';
import { sheetjsSource } from './sheetjsReference';
import type { WorkbookSource } from './source';
import { syntheticNodeBased } from './testWorkbook';
import { readWorkbook } from './workbook';

const FIXTURE = new URL('../../../../../scripts/wbt-import/fixtures/synthetic_b023.xlsx', import.meta.url);
const fixture = () => new Blob([readFileSync(FIXTURE)]);

const deps: WorkerDeps<WorkbookSource> = {
	read: async (file, onProgress) => readWorkbook(await file.arrayBuffer(), { onProgress }),
	extract: extractProject,
	readNodeCrops: async (file, fileName, onProgress) => readNodeCropWorkbook(await file.arrayBuffer(), fileName, { onProgress })
};
const nodeBased = () => new File([syntheticNodeBased().toFile()], 'node-based.xlsx');

async function drive(messages: ToWorker[], d = deps): Promise<FromWorker[]> {
	const out: FromWorker[] = [];
	const state: WorkerState<WorkbookSource> = { workbook: null, fileName: '' };
	for (const m of messages) await handle(m, state, (x) => out.push(x), d);
	return out;
}

describe('toFailure', () => {
	it('keeps each typed error’s code and the fields the UI needs', () => {
		expect(toFailure(new NotB023WorkbookError(['zNetwork_ElementNameLst', 'zAppSet_MonthDays']))).toMatchObject({
			code: 'not-b023',
			missing: ['zNetwork_ElementNameLst', 'zAppSet_MonthDays']
		});
		expect(toFailure(new UnreadableWorkbookError('it is encrypted', 'encrypted'))).toMatchObject({ code: 'unreadable', reason: 'encrypted' });
		expect(toFailure(new WorkbookTooLargeError('unpacked', 3e8, 2.5e8))).toMatchObject({ code: 'too-large', what: 'unpacked' });
		expect(toFailure(new UnsupportedVersionError('b031'))).toMatchObject({ code: 'unsupported-version', message: expect.stringContaining('b031') });
		expect(toFailure(new InvalidWorkbookError('Dates jump', 'Flow data', 'B12'))).toEqual({ code: 'invalid-workbook', message: 'Dates jump', sheet: 'Flow data', cell: 'B12' });
		expect(toFailure(new InvalidImportOptionsError('The gauge scaling date and factor go together.'))).toMatchObject({ code: 'invalid-options' });
	});

	it('turns anything else into an internal failure with its message', () => {
		expect(toFailure(new TypeError('boom'))).toEqual({ code: 'internal', message: 'boom' });
		expect(toFailure('plain')).toEqual({ code: 'internal', message: 'plain' });
	});

	it('survives structured cloning (what postMessage does)', () => {
		const f = toFailure(new NotB023WorkbookError(['zAppVer']));
		expect(structuredClone(f)).toEqual(f);
	});
});

describe('handle: the worker protocol', () => {
	it('reports progress per sheet, then the project, then re-extracts with other options', async () => {
		const out = await drive([
			{ type: 'parse', file: fixture(), fileName: 'synthetic_b023.xlsx', options: {} },
			{ type: 'extract', options: { gaugeAsReference: { scalingFrom: '2021-10-01', scaleFactor: 0.8 } } }
		]);
		const reads = out.flatMap((m) => (m.type === 'progress' && m.progress.stage === 'read' ? [`${m.progress.step}/${m.progress.steps} ${m.progress.sheet}`] : []));
		expect(reads[0]).toBe('1/10 AppSettings');
		expect(reads.at(-1)).toBe('10/10 EWR Cfg');
		const results = out.filter((m): m is Extract<FromWorker, { type: 'result' }> => m.type === 'result');
		expect(results).toHaveLength(2);
		const expected = JSON.parse(readFileSync(new URL('synthetic_b023.project.json', FIXTURE), 'utf8'));
		expect(results[0]!.result.project.name).toBe(expected.name);
		expect(results[0]!.result.project.series.map((s) => s.kind)).toContain('flow_observed_m3s');
		expect(results[1]!.result.project.series.map((s) => s.kind)).toContain('flow_reference_m3s');
		// Only progress precedes each result; no error anywhere.
		expect(out.some((m) => m.type === 'error')).toBe(false);
		// Everything the worker posts survives structured cloning.
		expect(structuredClone(results[0]!.result)).toEqual(results[0]!.result);
	});

	it('passes the run-of-river option to the extractor, off unless asked', async () => {
		const out = await drive([
			{ type: 'parse', file: fixture(), fileName: 'synthetic_b023.xlsx', options: {} },
			{ type: 'extract', options: { runOfRiver: true } },
			{ type: 'extract', options: {} }
		]);
		const rules = out.flatMap((m) => (m.type === 'result' ? [m.result.project.model.nodes.filter((n) => n.supplyRule === 'runOfRiver').map((n) => n.name)] : []));
		expect(rules).toEqual([[], ['Delta Farm', 'India Farm'], []]);
	});

	it('posts a typed error for a workbook that is not b023', async () => {
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Farm', 'Area'], ['A', 1]]), 'Sheet1');
		const file = new Blob([XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer]);
		const out = await drive([{ type: 'parse', file, fileName: 'other.xlsx', options: {} }]);
		const last = out.at(-1)!;
		expect(last.type).toBe('error');
		if (last.type !== 'error') return;
		expect(last.error.code).toBe('not-b023');
		expect(last.error.missing).toContain('zNetwork_ElementNameLst');
	});

	it('posts an unreadable error for a file that is not a workbook, and invalid options as such', async () => {
		const [bad] = await drive([{ type: 'parse', file: new Blob(['date,rain\n']), fileName: 'rain.xlsx', options: {} }]);
		expect(bad).toMatchObject({ type: 'error', error: { code: 'unreadable', reason: 'not-zip' } });
		const out = await drive([{ type: 'parse', file: fixture(), fileName: 'synthetic_b023.xlsx', options: { gaugeAsReference: { scalingFrom: '2021-13-01', scaleFactor: 1 } } }]);
		expect(out.at(-1)).toMatchObject({ type: 'error', error: { code: 'invalid-options' } });
	});

	it('reads a node-based workbook’s crop sheets, with progress for just those two sheets', async () => {
		const out = await drive([{ type: 'nodeCrops', file: nodeBased(), fileName: 'node-based.xlsx' }]);
		expect(out.flatMap((m) => (m.type === 'progress' ? [`${m.progress.step}/${m.progress.steps} ${m.progress.sheet}`] : []))).toEqual(['1/2 Crop_Factors', '2/2 Crop_Areas']);
		const last = out.at(-1)!;
		expect(last.type).toBe('nodeCrops');
		if (last.type !== 'nodeCrops') return;
		expect(last.result).toMatchObject({ shape: 'fao-et0', fileName: 'node-based.xlsx', warnings: [] });
		expect(last.result.crops).toHaveLength(3);
	});

	it('forgets the parsed b023 workbook after a node-based read, so extract fails', async () => {
		const out = await drive([
			{ type: 'parse', file: fixture(), fileName: 'synthetic_b023.xlsx', options: {} },
			{ type: 'nodeCrops', file: nodeBased(), fileName: 'node-based.xlsx' },
			{ type: 'extract', options: {} }
		]);
		expect(out.at(-1)).toEqual({ type: 'error', error: { code: 'internal', message: 'No workbook has been read yet.' } });
	});

	it('posts an unreadable error for a node-based read of a file that is not a workbook', async () => {
		expect(await drive([{ type: 'nodeCrops', file: new Blob(['x']), fileName: 'x.xlsx' }])).toEqual([
			{ type: 'error', error: expect.objectContaining({ code: 'unreadable', reason: 'not-zip' }) }
		]);
	});

	it('refuses extract before any parse', async () => {
		expect(await drive([{ type: 'extract', options: {} }])).toEqual([{ type: 'error', error: { code: 'internal', message: 'No workbook has been read yet.' } }]);
	});
});

/** A fake worker that answers through handle(), asynchronously like a real one. */
function fakeWorker(d = deps) {
	const state: WorkerState<WorkbookSource> = { workbook: null, fileName: '' };
	const w: WorkerLike & { terminated: boolean; posted: ToWorker[] } = {
		terminated: false,
		posted: [],
		onmessage: null,
		onerror: null,
		postMessage(m) {
			this.posted.push(m);
			void handle(m, state, (x) => !w.terminated && w.onmessage?.({ data: x } as MessageEvent<FromWorker>), d);
		},
		terminate() {
			this.terminated = true;
		}
	};
	return w;
}

describe('createWorkbookImport: the page side', () => {
	const file = () => new File([readFileSync(FIXTURE)], 'synthetic_b023.xlsx');

	it('parses with progress, re-extracts, and closes the worker', async () => {
		const w = fakeWorker();
		const session = createWorkbookImport(() => w);
		const seen: string[] = [];
		const first = await session.parse(file(), {}, (p) => seen.push(`${p.stage} ${p.sheet}`));
		expect(first.project.series.some((s) => s.kind === 'flow_observed_m3s')).toBe(true);
		expect(seen).toContain('read Flow data');
		expect(seen).toContain('extract Flow data');
		const second = await session.extract({ gaugeAsReference: true });
		expect(second.project.series.some((s) => s.kind === 'flow_reference_m3s')).toBe(true);
		expect(w.posted.map((m) => m.type)).toEqual(['parse', 'extract']);
		session.close();
		expect(w.terminated).toBe(true);
	});

	it('readNodeCrops resolves with the crop set, with progress', async () => {
		const w = fakeWorker();
		const session = createWorkbookImport(() => w);
		const seen: string[] = [];
		const set = await session.readNodeCrops(nodeBased(), (p) => seen.push(`${p.stage} ${p.sheet}`));
		expect(set.crops.map((c) => c.name)).toEqual(['Lucerne', 'Olives', 'Wine grapes']);
		expect(seen).toEqual(['read Crop_Factors', 'read Crop_Areas']);
		expect(w.posted).toEqual([expect.objectContaining({ type: 'nodeCrops', fileName: 'node-based.xlsx' })]);
		const err = await session.readNodeCrops(new File(['nope'], 'x.xlsx')).catch((e: unknown) => e);
		expect((err as WorkbookImportFailed).failure).toMatchObject({ code: 'unreadable' });
		session.close();
		expect(w.terminated).toBe(true);
	});

	it('readNodeCrops is refused while another read is pending', async () => {
		const session = createWorkbookImport(() => fakeWorker());
		const first = session.parse(file(), {});
		await expect(session.readNodeCrops(nodeBased())).rejects.toThrow('The workbook reader is busy.');
		await first;
		session.close();
	});

	it('rejects with the typed failure', async () => {
		const session = createWorkbookImport(() => fakeWorker());
		const err = await session.parse(new File(['not a workbook'], 'x.xlsx'), {}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(WorkbookImportFailed);
		expect((err as WorkbookImportFailed).failure).toMatchObject({ code: 'unreadable' });
	});

	it('cancel terminates the worker and rejects the pending read at once', async () => {
		let release: () => void = () => {};
		const slow: WorkerDeps<WorkbookSource> = { ...deps, read: () => new Promise((resolve) => (release = () => resolve(sheetjsSource(XLSX.utils.book_new())))) };
		const w = fakeWorker(slow);
		const session = createWorkbookImport(() => w);
		const p = session.parse(file(), {});
		session.cancel();
		await expect(p).rejects.toBeInstanceOf(WorkbookImportCancelled);
		expect(w.terminated).toBe(true);
		release(); // a late answer from the terminated worker is ignored
		await expect(session.extract({})).rejects.toThrow('No workbook has been read yet.');
	});

	it('a worker that fails to start rejects with an internal failure', async () => {
		const w = fakeWorker();
		w.postMessage = function () {
			this.onerror?.({ message: '' } as ErrorEvent);
		};
		const err = await createWorkbookImport(() => w)
			.parse(file(), {})
			.catch((e: unknown) => e);
		expect((err as WorkbookImportFailed).failure).toEqual({ code: 'internal', message: 'The workbook reader stopped unexpectedly.' });
	});
});
