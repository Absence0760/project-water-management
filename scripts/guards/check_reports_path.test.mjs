// Tests for check_reports_path.mjs, plus the check itself against the real
// frontend tree (this is what runs in CI's guard step).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { decodeEscapes, findProblems, routeProblem, scan, WHY } from './check_reports_path.mjs';

describe('routeProblem', () => {
	it('flags a top-level reports route, through groups and escapes', () => {
		assert.match(routeProblem(['reports']), /top-level route "\/reports"/);
		assert.match(routeProblem(['(app)', 'reports']), /top-level route/);
		assert.match(routeProblem(['(a)', '(b)', 'reports', '[id]']), /top-level route/);
		assert.match(routeProblem(['[x+72]eports']), /top-level route/);
		assert.equal(decodeEscapes('[u+0072]eports'), 'reports');
	});

	it('flags a top-level dynamic segment, which would match /reports/… too', () => {
		for (const seg of ['[slug]', '[id=uuid]', '[...rest]', '[[lang]]', 'r[x]']) assert.match(routeProblem([seg]), /dynamic route segment/, seg);
		assert.match(routeProblem(['(group)', '[...path]']), /dynamic/);
	});

	it('allows reports anywhere but the top, and other top-level names (positive control)', () => {
		assert.equal(routeProblem(['projects', '[id]', 'reports', '[jobId]']), null);
		assert.equal(routeProblem(['projects', '[id]', 'report']), null);
		assert.equal(routeProblem(['report']), null);
		assert.equal(routeProblem(['reports-archive']), null);
		assert.equal(routeProblem(['Reports']), null); // CloudFront path patterns are case-sensitive
		assert.equal(routeProblem(['(app)']), null);
	});
});

describe('findProblems', () => {
	it('reports each clash once, at the directory where it starts, and static files under /reports', () => {
		const problems = findProblems({
			routeDirs: [['(app)'], ['(app)', 'reports'], ['(app)', 'reports', '[id]'], ['projects'], ['projects', '[id]']],
			staticFiles: ['favicon.ico', 'reports/sample.pdf', 'reports-old.txt'],
		});
		assert.deepEqual(problems, [
			'frontend/src/routes/(app)/reports: a top-level route "/reports"',
			'frontend/static/reports/sample.pdf: a static file served at /reports/sample.pdf',
		]);
	});

	it('flags /packs the same way: a top-level route through groups and escapes, and static files (the packs bucket, infra/packs.tf)', () => {
		assert.match(routeProblem(['packs']), /top-level route "\/packs"/);
		assert.match(routeProblem(['(app)', '[x+70]acks']), /top-level route "\/packs"/);
		assert.match(routeProblem(['[slug]']), /also matches \/reports\/… and \/packs\/…/);
		// Positive control: a pack page lives under /projects/:id/packs, and a name that only starts with "packs" is fine.
		assert.equal(routeProblem(['projects', '[id]', 'packs', '[packId]']), null);
		assert.equal(routeProblem(['packs-archive']), null);
		assert.deepEqual(findProblems({ routeDirs: [], staticFiles: ['packs/x.pdf', 'packs-old.txt'] }), ['frontend/static/packs/x.pdf: a static file served at /packs/x.pdf']);
	});

	it('the explanation names the CloudFront behaviour', () => {
		assert.match(WHY, /CloudFront routes \/reports\/\*/);
		assert.match(WHY, /\/packs\/\* to the private packs bucket/);
		assert.match(WHY, /infra\/s3_cloudfront\.tf/);
	});
});

describe('scan', () => {
	it('finds a route and a static file in a tree on disk', () => {
		const root = mkdtempSync(join(tmpdir(), 'reports-path-'));
		mkdirSync(join(root, 'frontend/src/routes/(g)/reports'), { recursive: true });
		writeFileSync(join(root, 'frontend/src/routes/(g)/reports/+page.svelte'), '');
		mkdirSync(join(root, 'frontend/static/reports'), { recursive: true });
		writeFileSync(join(root, 'frontend/static/reports/x.pdf'), '');
		assert.equal(findProblems(scan(root)).length, 2);
	});
});

describe('the real frontend', () => {
	it('owns nothing under /reports or /packs (CloudFront serves signed report and pack PDFs there)', () => {
		const tree = scan();
		assert.ok(tree.routeDirs.some((s) => s[0] === 'projects'), 'positive control: the scan sees the routes');
		const problems = findProblems(tree);
		assert.deepEqual(problems, [], `${problems.join('\n')}\n${WHY}`);
	});
});
