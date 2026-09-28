#!/usr/bin/env node
// The Lambda bundle guards (infra/scripts/package-lambdas.sh).
//
// Reads the esbuild metafile of one Lambda bundle and refuses it when it
// carries a package it must not. A package can reach a bundle two ways, and
// the metafile records them in different places:
//
//   - bundled: its files are inputs, so `inputs` has a key under
//     node_modules/<pkg>/;
//   - external (`--external:<pkg>`): nothing of it is an input. The only trace
//     is the import left in the output, `outputs[…].imports[]` with
//     `external: true`, a `path` of `<pkg>` or `<pkg>/…`, and a `kind`
//     (`import-statement`, `require-call`, `dynamic-import`, …).
//
// Checking only the inputs, as the script first did, can never see an external
// package (issue #126): playwright-core is external in every bundle, so a
// static import of it in the API would have passed, and the Lambda would crash
// at load on `Cannot find package 'playwright-core'`. A `--forbid-static <pkg>`
// rule therefore also refuses an external import of it of any kind other than
// `dynamic-import`. The dynamic one stays allowed: backend/src/reports/render.ts
// loads playwright-core lazily, the API and worker bundles reach that module,
// and it only runs where the package is installed (the renderer image, the
// inline renderer in tests).
//
// The guard first checks that the metafile names the bundle's own
// src/lambda*.ts entry and at least one output, so an empty or reshaped
// metafile fails loudly instead of passing every rule.
//
// Run:   node scripts/guards/check_lambda_bundle.mjs <metafile.json> <name>
//          [--forbid <pkg> <why>]… [--forbid-static <pkg> <why>]…
//        (package-lambdas.sh runs it once per bundle)
// Tests: node --test scripts/guards/check_lambda_bundle.test.mjs (pnpm test:guards)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENTRY = /(^|\/)src\/lambda[\w-]*\.ts$/;

/** Whether an import path names `pkg` itself or a subpath of it. */
const isPackage = (path, pkg) => path === pkg || path.startsWith(`${pkg}/`);

/**
 * The problems with one bundle's metafile, as messages (empty when it passes).
 * `rules` is [{ pkg, why, allowDynamic }]: the package must be neither bundled
 * nor imported as an external, except, when `allowDynamic`, by `import()`.
 */
export function checkMetafile(meta, name, rules) {
	const inputs = Object.keys(meta?.inputs ?? {});
	const outputs = Object.entries(meta?.outputs ?? {});
	if (!inputs.some((p) => ENTRY.test(p)) || outputs.length === 0) {
		return [`${name}: the metafile lists no src/lambda*.ts entry or no output, so the bundle guards cannot run`];
	}
	const errors = [];
	for (const { pkg, why, allowDynamic } of rules) {
		const bundled = inputs.filter((p) => p.includes(`node_modules/${pkg}/`));
		if (bundled.length) {
			errors.push(`the ${name} bundle carries ${pkg} (${why}):\n  ${bundled.slice(0, 5).join('\n  ')}`);
		}
		const imports = outputs.flatMap(([out, o]) =>
			(o.imports ?? [])
				.filter((i) => i.external && isPackage(i.path, pkg) && !(allowDynamic && i.kind === 'dynamic-import'))
				.map((i) => `${out.split('/').pop()}: ${i.kind} of external '${i.path}'`),
		);
		if (imports.length) {
			const how = allowDynamic ? 'a static (non-dynamic) import of' : 'an import of';
			errors.push(
				`the ${name} bundle has ${how} ${pkg} (${why}); only a lazy \`await import('${pkg}')\` may reach it:\n  ${[...new Set(imports)].slice(0, 5).join('\n  ')}`,
			);
		}
	}
	return errors;
}

/** Parse the CLI arguments into { file, name, rules }. */
export function parseArgs(argv) {
	const [file, name, ...rest] = argv;
	if (!file || !name) throw new Error('usage: check_lambda_bundle.mjs <metafile.json> <name> [--forbid|--forbid-static <pkg> <why>]…');
	const rules = [];
	for (let i = 0; i < rest.length; i += 3) {
		const [flag, pkg, why] = rest.slice(i, i + 3);
		if ((flag !== '--forbid' && flag !== '--forbid-static') || !pkg || !why) {
			throw new Error(`bad rule at '${rest.slice(i).join(' ')}': expected --forbid|--forbid-static <pkg> <why>`);
		}
		rules.push({ pkg, why, allowDynamic: flag === '--forbid-static' });
	}
	if (!rules.length) throw new Error('no rules given');
	return { file, name, rules };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	let args;
	try {
		args = parseArgs(process.argv.slice(2));
	} catch (e) {
		console.error(`error: ${e.message}`);
		process.exit(2);
	}
	const errors = checkMetafile(JSON.parse(readFileSync(args.file, 'utf8')), args.name, args.rules);
	for (const e of errors) console.error(`error: ${e}`);
	process.exit(errors.length ? 1 : 0);
}
