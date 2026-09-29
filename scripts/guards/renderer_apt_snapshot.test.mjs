import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
	ageDays,
	aptPins,
	baseImage,
	issueBody,
	parsePolicy,
	readSnapshot,
	rewriteDockerfile,
	snapshotDate,
	snapshotVerdict,
	todaySnapshot
} from './renderer_apt_snapshot.mjs';

const DIGEST = 'a'.repeat(64);
const dockerfile = (snapshot = '20260101T000000Z') => `# header: apt-get install is described here
FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:${DIGEST} AS deps
ARG APT_SNAPSHOT=${snapshot}
RUN apt-get update --snapshot "$APT_SNAPSHOT" \\
	&& apt-get install -y --no-install-recommends --snapshot "$APT_SNAPSHOT" \\
		g++=4:13.2.0-7ubuntu1 \\
		xz-utils=5.6.1+really5.4.5-1ubuntu0.2 \\
		libcurl4-openssl-dev=8.5.0-2ubuntu10.6 \\
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /deps
FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:${DIGEST}
ENV HOME=/tmp
`;

test('snapshot ids parse, and a malformed or impossible one does not', () => {
	assert.equal(snapshotDate('20260928T013000Z').toISOString(), '2026-09-28T01:30:00.000Z');
	assert.equal(snapshotDate('2026-09-28'), null);
	assert.equal(snapshotDate('20260231T000000Z'), null, 'Feb 31 does not roll into March');
	assert.equal(snapshotDate('20260928T250000Z'), null);
	assert.equal(snapshotDate(undefined), null);
});

test('age is whole days since the snapshot, never negative', () => {
	const id = '20260601T000000Z';
	assert.equal(ageDays(id, new Date('2026-06-01T23:59:59Z')), 0);
	assert.equal(ageDays(id, new Date('2026-08-30T00:00:00Z')), 90);
	assert.equal(ageDays(id, new Date('2026-08-31T00:00:00Z')), 91);
	assert.equal(ageDays(id, new Date('2026-05-01T00:00:00Z')), 0, 'a snapshot in the future is 0 days old');
	assert.throws(() => ageDays('latest', new Date()), /not a snapshot id/);
});

test('verdict: stale only past the limit (90 days by default)', () => {
	const text = dockerfile('20260601T000000Z');
	assert.deepEqual(snapshotVerdict(text, new Date('2026-08-30T12:00:00Z')), { snapshot: '20260601T000000Z', age: 90, maxDays: 90, stale: false });
	assert.equal(snapshotVerdict(text, new Date('2026-08-31T00:00:00Z')).stale, true);
	assert.equal(snapshotVerdict(text, new Date('2026-06-10T00:00:00Z'), 7).stale, true);
});

test('verdict: fails closed on nothing to read or a nonsense limit', () => {
	assert.throws(() => snapshotVerdict('FROM x\nRUN true\n', new Date()), /no ARG APT_SNAPSHOT/);
	assert.throws(() => snapshotVerdict(dockerfile('yesterday'), new Date()), /not a snapshot id/);
	assert.throws(() => snapshotVerdict(dockerfile(), new Date(), 0), /positive number/);
	assert.throws(() => snapshotVerdict(dockerfile(), new Date(), Number('x')), /positive number/);
});

test('the repo Dockerfile has a readable snapshot, a digest-pinned base and pinned packages', () => {
	const text = readFileSync(new URL('../../backend/renderer.Dockerfile', import.meta.url), 'utf8');
	assert.ok(snapshotDate(readSnapshot(text)), 'APT_SNAPSHOT is a snapshot id');
	assert.match(baseImage(text), /^mcr\.microsoft\.com\/playwright:v[\d.]+-noble@sha256:[0-9a-f]{64}$/);
	const pins = aptPins(text);
	assert.ok(pins.length >= 5, `found ${pins.length} pins`);
	assert.ok(pins.some((p) => p.name === 'g++'));
	assert.ok(pins.every((p) => p.version && !p.version.endsWith('\\')));
});

test('aptPins reads the install list and nothing after it', () => {
	assert.deepEqual(aptPins(dockerfile()), [
		{ name: 'g++', version: '4:13.2.0-7ubuntu1' },
		{ name: 'xz-utils', version: '5.6.1+really5.4.5-1ubuntu0.2' },
		{ name: 'libcurl4-openssl-dev', version: '8.5.0-2ubuntu10.6' }
	]);
	assert.equal(baseImage(dockerfile()), `mcr.microsoft.com/playwright:v1.63.0-noble@sha256:${DIGEST}`);
});

test('parsePolicy reads each Candidate and skips (none)', () => {
	const out = `g++:
  Installed: (none)
  Candidate: 4:13.2.0-7ubuntu1
  Version table:
     4:13.2.0-7ubuntu1 500
        500 https://snapshot.ubuntu.com/ubuntu/20260928T000000Z noble/main amd64 Packages
xz-utils:
  Installed: 5.6.1+really5.4.5-1ubuntu0.2
  Candidate: 5.6.1+really5.4.5-1ubuntu0.3
  Version table:
nosuchpkg:
  Installed: (none)
  Candidate: (none)
`;
	assert.deepEqual(
		[...parsePolicy(out)],
		[
			['g++', '4:13.2.0-7ubuntu1'],
			['xz-utils', '5.6.1+really5.4.5-1ubuntu0.3']
		]
	);
});

test('rewriteDockerfile moves the snapshot and every pinned version, and nothing else', () => {
	const versions = new Map([
		['g++', '4:13.2.0-7ubuntu1'],
		['xz-utils', '5.6.1+really5.4.5-1ubuntu0.3'],
		['libcurl4-openssl-dev', '8.5.0-2ubuntu10.15']
	]);
	const before = dockerfile();
	const after = rewriteDockerfile(before, '20260928T000000Z', versions);
	assert.equal(readSnapshot(after), '20260928T000000Z');
	assert.deepEqual(
		aptPins(after).map((p) => `${p.name}=${p.version}`),
		['g++=4:13.2.0-7ubuntu1', 'xz-utils=5.6.1+really5.4.5-1ubuntu0.3', 'libcurl4-openssl-dev=8.5.0-2ubuntu10.15']
	);
	const changed = before.split('\n').filter((l, i) => l !== after.split('\n')[i]);
	assert.deepEqual(changed, ['ARG APT_SNAPSHOT=20260101T000000Z', '\t\txz-utils=5.6.1+really5.4.5-1ubuntu0.2 \\', '\t\tlibcurl4-openssl-dev=8.5.0-2ubuntu10.6 \\']);
	assert.match(after, /\t\tlibcurl4-openssl-dev=8\.5\.0-2ubuntu10\.15 \\\n\t&& rm -rf/, 'the line continuation survives');
});

test('rewriteDockerfile refuses a package the snapshot has no candidate for, or a bad id', () => {
	const partial = new Map([['g++', '1']]);
	assert.throws(() => rewriteDockerfile(dockerfile(), '20260928T000000Z', partial), /no candidate .* xz-utils, libcurl4-openssl-dev/);
	assert.throws(() => rewriteDockerfile(dockerfile(), 'today', new Map()), /not a snapshot id/);
	assert.throws(() => rewriteDockerfile('FROM x\n', '20260928T000000Z', new Map()), /no ARG APT_SNAPSHOT/);
});

test('todaySnapshot is midnight UTC on the day', () => {
	assert.equal(todaySnapshot(new Date('2026-09-28T23:59:00Z')), '20260928T000000Z');
	assert.ok(snapshotDate(todaySnapshot(new Date())));
});

test('the issue body names the snapshot, its age and the bump procedure', () => {
	const body = issueBody({ snapshot: '20260601T000000Z', age: 120, maxDays: 90 });
	assert.match(body, /120 days old/);
	assert.match(body, /APT_SNAPSHOT=20260601T000000Z/);
	assert.match(body, /pnpm gen:renderer-apt/);
	assert.match(body, /pnpm check:pins && pnpm check:renderer-image/);
	assert.match(body, /docker` PR/);
});
