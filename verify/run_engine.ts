// The engine side of the independent cross-check (verify/README.md). It calls
// only the engine's public entry point, `runModel`, and writes what it
// returns; verify/model.py is the other side and never sees this code.
//
//   tsx verify/run_engine.ts run <input.json> <output.json> [<input.json> <output.json> …]
//   tsx verify/run_engine.ts examples <out dir>
//
// `run` reads a ModelInput document and writes { startDate, endDate, days,
// warnings, series: [{ nodeId, key, values }] } (NaN written as null), or
// { error } when runModel refuses the input.
// `examples` writes the three invented example catchments' inputs, as
// `pnpm seed:examples` builds them, without the automatic fit (so on GR4J's
// stored parameters), one `<key>.input.json` each.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runModel, type ModelInput } from '../packages/engine/src/index.ts';
import { buildExamples, inputOf } from '../backend/scripts/examples/catchments.ts';

const [cmd, ...args] = process.argv.slice(2);

function runOne(inPath: string, outPath: string): void {
	const input = JSON.parse(readFileSync(inPath, 'utf8')) as ModelInput;
	let out;
	try {
		out = runModel(input);
	} catch (e) {
		// A refused run (docs/model.md: no evaporation, shares over 1, no catchment area): model.py must refuse it too.
		writeFileSync(outPath, JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
		return;
	}
	const doc = {
		engineVersion: out.engineVersion,
		startDate: out.startDate,
		endDate: out.endDate,
		days: out.days,
		warnings: out.summary.warnings ?? [],
		series: out.series.map((s) => ({ nodeId: s.nodeId, key: s.key, values: s.values.map((v) => (Number.isFinite(v) ? v : null)) }))
	};
	writeFileSync(outPath, JSON.stringify(doc));
}

if (cmd === 'run') {
	if (args.length === 0 || args.length % 2 !== 0) throw new Error('run needs <input.json> <output.json> pairs');
	for (let i = 0; i < args.length; i += 2) runOne(args[i]!, args[i + 1]!);
} else if (cmd === 'examples') {
	const dir = args[0];
	if (!dir) throw new Error('examples needs an output directory');
	mkdirSync(dir, { recursive: true });
	buildExamples({ fit: false }).forEach((ex, i) => {
		const key = ['kleinberg', 'droevlei', 'sandspruit'][i] ?? `example${i}`;
		writeFileSync(join(dir, `${key}.input.json`), JSON.stringify({ name: ex.name, ...inputOf(ex) }));
	});
} else {
	throw new Error(`unknown command ${cmd ?? '(none)'}: use run or examples`);
}
