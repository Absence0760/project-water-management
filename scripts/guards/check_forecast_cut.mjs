#!/usr/bin/env node
// Every view over a run's stored daily series treats a forecast run's
// forecast days on purpose (docs/followups.md § POPIA and the Step 2 release,
// "One guard for views over a run's stored series"; issue #51 found four that
// didn't, one at a time).
//
// A forecast run (WP-2.12) runs on past the record on forecast rain; its
// summary covers the days before summary.forecast.from only. So every reader
// of its daily series (run_series) must do one of:
//   cut          a figure over the record (a count, a mean, a ranking, the
//                level "now"): the series cut before the forecast
//                (engine views/fdc.ts beforeForecast, or a helper built on it);
//   band         a daily chart: the whole series, the forecast days in the
//                labelled band (forecast/forecast.ts forecastBand);
//   whole        an export or a reproduction: every day, the forecast days
//                flagged (the daily CSVs' F column, the .xlsx flag) or kept
//                bit-exact for re-running;
//   never        reads only runs that are never forecast runs (a scenario's,
//                a sweep's, an application's base), refused where they're made;
//   no-values    reads which series a run stored, not their values;
//   one-day      reads one day the reader picked (the day trace);
//   passes-on    hands the series to a client that does one of the above
//                (the API route, the prefetch cache).
//
// The inventory below names every reader: the frontend's fetches of a run's
// series (api.runs.series, the bulk route, a share link's series), the
// backend's `FROM run_series`, and every SQL function whose latest definition
// in backend/migrations reads run_series. Each entry gives how many reads the
// file has, how it treats a forecast run, and a piece of text that shows it
// (`evidence`, in that file unless `in` names another). The check fails when
// a reader isn't listed, its count changed, a listed file reads no series any
// more, or its evidence is gone: a new view over stored series has to say
// what it does with the forecast days before it lands.
//
// Run:   node scripts/guards/check_forecast_cut.mjs
// Tests: node --test scripts/guards/check_forecast_cut.test.mjs (pnpm test:guards;
//        it also checks the real tree, which is what CI's guard step runs).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

export const HOWS = ['cut', 'band', 'cut+band', 'whole', 'never', 'no-values', 'one-day', 'passes-on'];

/** What counts as reading a run's stored daily series, per tree. */
export const READERS = {
	frontend: [/\bapi\.runs\.series\(/g, /\/series\/bulk\b/g, /\bseries\(token,/g],
	backend: [/\bFROM\s+run_series\b/g]
};

/**
 * Every reader. `path` is a file (or `sql:<function>` for a SQL function),
 * `reads` the number of reads in it, `how` one of HOWS, `evidence` text that
 * must stay in the file (or in `in`).
 */
export const INVENTORY = [
	// --- frontend ---------------------------------------------------------------
	{ path: 'frontend/src/lib/components/compare/CompareOverlay.svelte', reads: 1, how: 'cut+band', evidence: ['recordOf(pair.a, forecastA)', '{band}'] },
	{ path: 'frontend/src/lib/components/compare/ReserveYearsChart.svelte', reads: 1, how: 'cut', evidence: ['reserveDaysByWaterYear(x.value.startDate, x.value.values, list[i]!.forecastFrom'] },
	{ path: 'frontend/src/lib/components/dams/DamsTab.svelte', reads: 1, how: 'cut+band', evidence: ['beforeForecast(s.values', 'band={forecastBand('] },
	{ path: 'frontend/src/lib/components/map/mapResults.svelte.ts', reads: 1, how: 'cut', evidence: ['meta.forecastFrom ?? null'], note: 'loadDamLevels cuts (overview/damLevels.ts)' },
	{ path: 'frontend/src/lib/components/network/NetworkTab.svelte', reads: 2, how: 'cut', evidence: ['latestRun?.forecastFrom ?? null', 'damLevel(dam, s, latestRun?.forecastFrom'] },
	{ path: 'frontend/src/lib/components/outcomes/OutcomeMatrixPanel.svelte', reads: 1, how: 'never', evidence: ['!run.forecastFrom'], note: 'a demand sweep is based on an ordinary run only' },
	{ path: 'frontend/src/lib/components/overview/FlowVsReserve.svelte', reads: 1, how: 'cut+band', evidence: ['belowReserve(record(flows.shortfall))', '{band}'] },
	{ path: 'frontend/src/lib/components/overview/OverviewTab.svelte', reads: 1, how: 'cut', evidence: ['const forecastFrom = run.summary.forecast?.from ?? null;'], note: 'loadDamLevels cuts (overview/damLevels.ts)' },
	{ path: 'frontend/src/lib/components/overview/damLevels.ts', reads: 0, how: 'cut', evidence: ['beforeForecast(series.values, series.startDate, forecastFrom)'], note: 'loadDamLevels / damLevel, which the dam readers call' },
	{ path: 'frontend/src/lib/components/runs/RecessionDiagnostics.svelte', reads: 1, how: 'never', evidence: ['check.segments'], note: 'only the summary’s recession segments: observed-flow days, which a forecast has none of' },
	{ path: 'frontend/src/lib/components/runs/ReportWindowPanel.svelte', reads: 1, how: 'cut', evidence: ['resolveWindow(choice, run, stored)'], note: 'reportWindow.ts ends a forecast run’s windows before the forecast' },
	{ path: 'frontend/src/lib/components/runs/RunChart.svelte', reads: 1, how: 'band', evidence: ['{band}'] },
	{ path: 'frontend/src/lib/components/runs/RunCharts.svelte', reads: 1, how: 'cut+band', evidence: ['beforeForecast(conv(d), d.startDate, forecastFrom)', '{band}'] },
	{ path: 'frontend/src/lib/components/runs/RunoffPanel.svelte', reads: 1, how: 'band', evidence: ['{band}'] },
	{ path: 'frontend/src/lib/components/runs/RunsTab.svelte', reads: 1, how: 'passes-on', evidence: ['prefetchSeries('], note: 'warms the cache the charts read' },
	{ path: 'frontend/src/lib/components/share/load.ts', reads: 2, how: 'cut', evidence: ['pub.forecast_from'], in: 'backend/migrations/190_history_viewer_share_forecast.sql', note: 'app_share_series cuts in the database' },
	{ path: 'frontend/src/lib/components/supply/SupplyTab.svelte', reads: 1, how: 'cut', evidence: ['weekWindow(run)'], note: 'resolveWindow’s last 7 days end before the forecast' },
	{ path: 'frontend/src/lib/components/supply/UnitDetail.svelte', reads: 1, how: 'band', evidence: ['{band}'] },
	{ path: 'frontend/src/lib/export/urls.ts', reads: 1, how: 'whole', evidence: ['withForecastFlag'], in: 'frontend/src/lib/spreadsheet/export/collect.ts', note: 'the .xlsx: every daily sheet leads with the forecast flag' },
	{
		path: 'frontend/src/routes/projects/[id]/report/+page.svelte',
		reads: 2,
		how: 'cut+band',
		evidence: ['forecastFrom: run.summary.forecast?.from ?? null', 'band={forecastBand(summary.forecast?.from)}', 'beforeForecast(s.values, s.startDate, forecastFrom)'],
		in: ['frontend/src/routes/projects/[id]/report/+page.svelte', 'frontend/src/routes/projects/[id]/report/+page.svelte', 'frontend/src/lib/components/report/licenceImpact.ts'],
		note: 'the FDC table, the printed charts, and the licence-impact board (licenceImpact.ts)'
	},
	// --- backend ----------------------------------------------------------------
	{ path: 'backend/src/allocations/runUse.ts', reads: 1, how: 'cut', evidence: ['beforeForecast(values, startDate, forecastFrom)'] },
	{ path: 'backend/src/compare/routes.ts', reads: 1, how: 'no-values', evidence: ["SELECT key, meta->>'label' AS label, meta->>'unit' AS unit"] },
	{ path: 'backend/src/evidence/bundle.ts', reads: 1, how: 'whole', evidence: ['FORECAST_NOT_SIGNABLE'], in: 'backend/src/evidence/packs.ts', note: 'a pack’s reproduction bundle, bit-exact; a forecast run can’t be in a signed pack' },
	{ path: 'backend/src/evidence/report.ts', reads: 1, how: 'never', evidence: ['that run is a forecast run; base a scenario on an ordinary run'], in: 'backend/src/scenarios/execute.ts', note: 'an application run and its base' },
	{ path: 'backend/src/export/daily-columns.ts', reads: 1, how: 'whole', evidence: ['forecastColumn(run.startDate, run.summary.forecast)'], in: 'backend/src/export/routes.ts', note: 'the daily CSV leads with the F column; the bulk route feeds the .xlsx, which flags it (collect.ts)' },
	{ path: 'backend/src/export/fdc.ts', reads: 1, how: 'cut', evidence: ['return fdcPercentileTable(flows, run);'], note: 'the engine ranks the days before run.forecastFrom' },
	{ path: 'backend/src/export/routes.ts', reads: 2, how: 'whole', evidence: ['forecastColumn(run.startDate, run.summary.forecast)', 'values[i + shift]'], in: ['backend/src/export/routes.ts', 'backend/src/export/series-columns.ts'], note: 'farms.csv with the F column; an input series’ export, the run’s columns on that series’ own days' },
	{ path: 'backend/src/farms/view.ts', reads: 2, how: 'cut', evidence: ['cur.view.dataUntil'], note: 'never past dataUntil, the day before the forecast' },
	{ path: 'backend/src/portfolio/portfolio.ts', reads: 1, how: 'never', evidence: ["r.trigger <> 'forecast'"] },
	{ path: 'backend/src/publish/publish.ts', reads: 1, how: 'cut', evidence: ["(summary->'forecast'->>'from')::date - 1"], note: 'the projection stops at observed_until; the forecast is its own part' },
	{ path: 'backend/src/runs/reproduce.ts', reads: 1, how: 'whole', evidence: ['FROM run_series WHERE run_id = $1'], note: 'reproducing a run compares every stored day' },
	{ path: 'backend/src/runs/routes.ts', reads: 4, how: 'passes-on', evidence: ['.get(\'/:id/runs/:runId/series\'', '.get(\'/:id/runs/:runId/day\''], note: 'the series route (the client cuts or bands), the series list (no values), and the day trace (one picked day)' },
	{ path: 'backend/src/scenarios/results.ts', reads: 1, how: 'never', evidence: ['that run is a forecast run; base a scenario on an ordinary run'], in: 'backend/src/scenarios/execute.ts' },
	// --- SQL functions (latest definitions) --------------------------------------
	{ path: 'sql:app_share_series', reads: 1, how: 'cut', evidence: ['pub.forecast_from'], in: 'backend/migrations/190_history_viewer_share_forecast.sql' },
	{ path: 'sql:app_run_digest_body', reads: 1, how: 'whole', evidence: ['app_run_digest_body'], in: 'backend/migrations/115_scenario_share_notes.sql', note: 'the run’s stamp digests every stored day' }
];

const SKIP_DIR = new Set(['node_modules', '__tests__', '__fixtures__', '.svelte-kit', 'build', 'dist']);
const isTest = (f) => /\.(test|spec)\.[cm]?[jt]s$/.test(f);

function walk(dir, exts, out = []) {
	if (!existsSync(dir)) return out;
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) {
			if (!SKIP_DIR.has(name)) walk(p, exts, out);
		} else if (exts.some((e) => name.endsWith(e)) && !isTest(name)) out.push(p);
	}
	return out;
}

const count = (text, patterns) => patterns.reduce((n, re) => n + (text.match(new RegExp(re.source, re.flags)) ?? []).length, 0);

/**
 * The latest definition of every SQL function in the migrations, in order:
 * a later CREATE OR REPLACE replaces it, a DROP FUNCTION removes it.
 */
export function latestFunctions(files) {
	const fns = new Map();
	for (const { name, text } of files) {
		const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z_0-9]+)\s*\([\s\S]*?\$\$([\s\S]*?)\$\$|DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?([a-z_0-9]+)/gi;
		for (const m of text.matchAll(re)) {
			if (m[1]) fns.set(m[1], { file: name, body: m[2] });
			else fns.delete(m[3]);
		}
	}
	return fns;
}

/** Every reader in the tree under `root`: path → number of reads. */
export function scan(root = ROOT) {
	const found = new Map();
	for (const f of walk(join(root, 'frontend/src'), ['.ts', '.svelte'])) {
		const n = count(readFileSync(f, 'utf8'), READERS.frontend);
		if (n) found.set(relative(root, f), n);
	}
	for (const f of walk(join(root, 'backend/src'), ['.ts'])) {
		const n = count(readFileSync(f, 'utf8'), READERS.backend);
		if (n) found.set(relative(root, f), n);
	}
	const dir = join(root, 'backend/migrations');
	const migrations = existsSync(dir)
		? readdirSync(dir)
				.filter((f) => f.endsWith('.sql'))
				.sort()
				.map((f) => ({ name: f, text: readFileSync(join(dir, f), 'utf8') }))
		: [];
	for (const [fn, { body }] of latestFunctions(migrations)) {
		const n = count(body, [/\brun_series\b/g]);
		if (n) found.set(`sql:${fn}`, n);
	}
	return found;
}

/** What's wrong with the inventory against what the tree reads. */
export function findProblems(found, inventory = INVENTORY, read = (p) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : null)) {
	const problems = [];
	const listed = new Map(inventory.map((e) => [e.path, e]));
	for (const [path, n] of found) {
		const e = listed.get(path);
		if (!e) problems.push(`${path} reads a run's stored series (${n}×) but isn't in the inventory: say how it treats a forecast run's forecast days (cut, band, …) in scripts/guards/check_forecast_cut.mjs`);
		else if (e.reads !== n) problems.push(`${path} reads a run's stored series ${n}× but the inventory says ${e.reads}×: check the new read cuts or bands a forecast run, then update the entry`);
	}
	for (const e of inventory) {
		if (!HOWS.includes(e.how)) problems.push(`${e.path}: "${e.how}" is not one of ${HOWS.join(', ')}`);
		if (e.reads > 0 && !found.has(e.path)) problems.push(`${e.path} is in the inventory but reads no run series any more: remove its entry`);
		const where = Array.isArray(e.in) ? e.in : e.evidence.map(() => e.in ?? (e.path.startsWith('sql:') ? null : e.path));
		e.evidence.forEach((text, i) => {
			const file = where[i];
			const body = file ? read(file) : null;
			if (body === null) problems.push(`${e.path}: the file its evidence is in (${file}) is gone`);
			else if (!body.includes(text)) problems.push(`${e.path}: its evidence that it treats a forecast run as "${e.how}" (${JSON.stringify(text)}) is gone from ${file}`);
		});
	}
	return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const problems = findProblems(scan());
	if (problems.length) {
		for (const p of problems) console.error(`check_forecast_cut: ${p}`);
		process.exit(1);
	}
	console.log(`check_forecast_cut: ${INVENTORY.length} readers of a run's stored series, each says what it does with a forecast run's forecast days`);
}
