// The app is "Integrated Catchment - Water Balance Tool" (IC-WBT) since issue
// #551; it was "Water Management". The old name must not come back anywhere a
// user can meet it: this reads every text file of the frontend (its source,
// the static files: favicon, web manifest), the backend's source (emails, the
// authenticator issuer, the sender name), the engine, the e2e specs, the
// scripts, the Terraform (the sender's display name) and the brand sources,
// comments included and in any case, since no use of the old name is left.
// The repo, package, database and AWS names (`water-management`,
// `@water-management/*`) are identifiers, not the name, and the phrase doesn't
// match them. Build output and test results aren't read.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_NAME, APP_SHORT_NAME } from './brand.js';

const OLD_NAME = /water management/i;
const ROOT = resolve(import.meta.dirname, '../../..');
const TREES = ['frontend/src', 'frontend/static', 'backend/src', 'packages', 'e2e', 'scripts', 'infra', 'bin', 'brand/src', 'brand/build.py'];
const TEXT = /\.(ts|svelte|js|mjs|html|svg|webmanifest|json|css|py|tf|hcl|sh)$/;
const SELF = 'frontend/src/lib/brand.test.ts';

function* files(path: string): Generator<string> {
	let entries;
	try {
		entries = readdirSync(path, { withFileTypes: true });
	} catch {
		yield path; // a file
		return;
	}
	for (const e of entries) {
		if (e.name === 'node_modules' || e.name.startsWith('.') || (e.isDirectory() && (/^build/.test(e.name) || e.name === 'test-results'))) continue;
		yield* files(join(path, e.name));
	}
}

describe('the app name', () => {
	it('is the full name and its abbreviation', () => {
		expect(APP_NAME).toBe('Integrated Catchment - Water Balance Tool');
		expect(APP_SHORT_NAME).toBe('IC-WBT');
	});

	it('the old name, Water Management, is shown nowhere', () => {
		const found: string[] = [];
		let read = 0;
		for (const tree of TREES) {
			for (const file of files(join(ROOT, tree))) {
				const rel = relative(ROOT, file);
				if (rel === SELF || !TEXT.test(rel)) continue;
				read++;
				const lines = readFileSync(file, 'utf8').split('\n');
				lines.forEach((l, i) => {
					if (OLD_NAME.test(l)) found.push(`${rel}:${i + 1}`);
				});
			}
		}
		expect(read, 'the scan reached the trees').toBeGreaterThan(500);
		expect(found).toEqual([]);
	});

	it('the web manifest names the app, with the abbreviation for a home screen', () => {
		const manifest = JSON.parse(readFileSync(join(ROOT, 'frontend/static/site.webmanifest'), 'utf8'));
		expect(manifest).toMatchObject({ name: APP_NAME, short_name: APP_SHORT_NAME });
		expect(readFileSync(join(ROOT, 'frontend/src/app.html'), 'utf8')).toContain(`<title>${APP_SHORT_NAME}</title>`);
	});
});
