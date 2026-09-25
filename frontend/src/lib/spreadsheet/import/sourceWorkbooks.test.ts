// Skip-if-absent parity test on the real b023 workbooks (WP-1.31): the blank
// template and every client workbook in $WBT_SOURCE_DIR/Original/ (default
// ../project-water-management-source/Original/, beside the checkout). For each
// it runs scripts/wbt-import/extract_project.py into a temp directory outside
// the repo and asserts the TypeScript importer gives the same project.json
// and notes. It skips when the workbooks or Python with openpyxl are absent,
// so it never runs in CI. Client data stays out of the repo: nothing is
// written under it, and tests are named by position, not by file name.
//
// PYTHON picks the interpreter (default: the checkout's .venv, else python3).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type ExtractOptions, type GaugeScaling, extractProject, readWorkbook } from './index';
import { jsonDiff, projectNotes } from './parity';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../../..');
const SCRIPT = join(REPO, 'scripts/wbt-import/extract_project.py');

/** The repo and the directories above it, nearest first (a git worktree sits inside the main checkout). */
function ancestors(): string[] {
	const out: string[] = [];
	for (let d = REPO; ; d = dirname(d)) {
		out.push(d);
		if (dirname(d) === d) return out;
	}
}

function sourceDir(): string | null {
	const env = process.env.WBT_SOURCE_DIR;
	const candidates = env ? [resolve(REPO, env, 'Original')] : ancestors().map((d) => join(dirname(d), 'project-water-management-source', 'Original'));
	return candidates.find((d) => existsSync(d)) ?? null;
}

function python(): string | null {
	const candidates = [
		...(process.env.PYTHON ? [process.env.PYTHON] : []),
		// The .venv of this checkout, or of the main checkout when this is a worktree inside it.
		...ancestors()
			.filter((d) => existsSync(join(d, 'scripts/wbt-import/extract_project.py')))
			.map((d) => join(d, '.venv/bin/python')),
		'python3'
	];
	return candidates.find((py) => spawnSync(py, ['-c', 'import openpyxl'], { stdio: 'ignore' }).status === 0) ?? null;
}

const SOURCE = sourceDir();
const PY = SOURCE ? python() : null;
const WORKBOOKS = SOURCE
	? readdirSync(SOURCE)
			.filter((f) => /\.xls[xm]$/i.test(f) && !f.startsWith('~$'))
			.sort((a, b) => Number(!a.startsWith('Blank')) - Number(!b.startsWith('Blank')) || a.localeCompare(b))
	: [];

/**
 * The client gauge's known scaling, as bin/seed-demo.sh reads it
 * (WBT_GAUGE_SCALING_FROM / WBT_GAUGE_SCALE_FACTOR from the environment or
 * $WBT_SOURCE_DIR/wbt-import.env). Client data: read here, never printed.
 */
function gaugeScaling(): GaugeScaling | null {
	const vars: Record<string, string | undefined> = { ...process.env };
	const envFile = SOURCE ? join(dirname(SOURCE), 'wbt-import.env') : null;
	if (envFile && existsSync(envFile)) {
		for (const line of readFileSync(envFile, 'utf8').split('\n')) {
			const m = /^\s*(?:export\s+)?(WBT_GAUGE_[A-Z_]+)=["']?([^"'#\s]*)/.exec(line);
			if (m && vars[m[1]!] === undefined) vars[m[1]!] = m[2];
		}
	}
	const from = vars.WBT_GAUGE_SCALING_FROM;
	const factor = Number(vars.WBT_GAUGE_SCALE_FACTOR);
	return from && Number.isFinite(factor) && factor > 0 ? { scalingFrom: from, scaleFactor: factor } : null;
}

interface PythonRun {
	project: unknown;
	notes: string[];
	warnings: string[];
}

function runPython(workbook: string, args: string[]): PythonRun {
	const out = mkdtempSync(join(tmpdir(), 'wbt-parity-'));
	try {
		const r = spawnSync(PY!, [SCRIPT, workbook, out, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
		if (r.status !== 0) throw new Error(`extract_project.py exited ${r.status}`);
		return {
			project: JSON.parse(readFileSync(join(out, 'project.json'), 'utf8')),
			notes: projectNotes(r.stdout.split('\n').filter((l) => l.startsWith('  note: ')).map((l) => l.slice('  note: '.length))),
			warnings: r.stderr.split('\n').filter((l) => l.startsWith('  WARNING: ')).map((l) => l.slice(2))
		};
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
}

const available = Boolean(SOURCE && PY && WORKBOOKS.length);

describe.skipIf(!available)('parity with extract_project.py on the source workbooks (local only)', () => {
	WORKBOOKS.forEach((file, i) => {
		const label = file.startsWith('Blank') ? 'the blank template' : `source workbook ${i}`;
		const path = join(SOURCE!, file);
		const variants: [string, string[], Omit<ExtractOptions, 'fileName'>][] = [
			['default', [], {}],
			['--gauge-as-reference', ['--gauge-as-reference'], { gaugeAsReference: true }]
		];
		const scaling = file.startsWith('Blank') ? null : gaugeScaling();
		if (scaling) {
			const args = ['--gauge-as-reference', '--gauge-scaling-from', scaling.scalingFrom, '--gauge-scale-factor', String(scaling.scaleFactor)];
			variants.push(["--gauge-as-reference with the seed's scaling", args, { gaugeAsReference: scaling }]);
		}
		for (const [variant, args, opts] of variants) {
			it(`${label}, ${variant}`, { timeout: 180_000 }, () => {
				const py = runPython(path, args);
				const t0 = performance.now();
				const wb = readWorkbook(readFileSync(path));
				const t1 = performance.now();
				const result = extractProject(wb, { fileName: file, ...opts });
				const t2 = performance.now();
				// Timing only; no workbook content is printed.
				console.log(`${label} (${variant}): readWorkbook ${Math.round(t1 - t0)} ms, extractProject ${Math.round(t2 - t1)} ms`);
				expect(jsonDiff(result.project, py.project)).toBeNull();
				expect(result.notes.filter((n) => n.severity === 'info').map((n) => n.message)).toEqual(py.notes);
				expect(result.notes.filter((n) => n.severity === 'warning').map((n) => n.message)).toEqual(py.warnings);
			});
		}
	});
});

describe.skipIf(available)('parity with extract_project.py on the source workbooks (local only)', () => {
	it.skip(`needs the workbooks in ../project-water-management-source/Original/ and Python with openpyxl (${SOURCE ? 'no Python with openpyxl' : 'no workbooks'})`, () => {});
});
