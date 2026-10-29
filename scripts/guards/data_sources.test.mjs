// Tests for data_sources.mjs, plus the check itself against the real tree
// (this is what runs in CI's guard step).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { check, configSources, feedHosts, findProblems, migrationSources, registerEntries } from './data_sources.mjs';

const reader = (files) => (p) => files[p] ?? null;

const REGISTER = [
	'# Register',
	'',
	'| Id | Source | Status | Hosts | Feed source | Code |',
	'| --- | --- | --- | --- | --- | --- |',
	'| chirps | CHIRPS | live | `data.chc.ucsb.edu` | `chirps` | x |',
	'| gefs | GEFS | live | `data.chc.ucsb.edu` | `chirps_gefs` | x |',
	'| dws | DWS | live | `www.dws.gov.za` | `dws` | x |',
	'| dpet | dPET | reference load | `data.bris.ac.uk` | – | x |',
	'',
	'Text after the table, naming `elsewhere.example` in backticks.'
].join('\n');

describe('feedHosts', () => {
	const http = (list) => `import { CHC_BASE } from './sources/chirps.js';\nimport { X as DWS_BASE } from './sources/dws.js';\nconst LOCAL = 'https://local.example/path';\n// export const FEED_HOSTS = ['commented.example'];\nexport const FEED_HOSTS: readonly string[] = [${list}];\n`;
	const files = (list) => ({
		'backend/src/feeds/http.ts': http(list),
		'backend/src/feeds/sources/chirps.ts': "export const CHC_BASE = 'https://data.chc.ucsb.edu/products';",
		'backend/src/feeds/sources/dws.ts': "export const DWS_BASE = 'https://www.dws.gov.za/Hydrology/Verified/HyData.aspx';"
	});

	it('resolves imported and local constants, URL literals and plain strings (positive control)', () => {
		const r = feedHosts(reader(files("new URL(CHC_BASE).host, new URL(LOCAL).hostname, new URL('https://lit.example/x').host, 'plain.example'")));
		assert.deepEqual(r, { hosts: ['data.chc.ucsb.edu', 'local.example', 'lit.example', 'plain.example'], problems: [] });
	});

	it("fails an entry it can't read, rather than skipping it", () => {
		const r = feedHosts(reader(files('new URL(CHC_BASE).host, ...MORE_HOSTS')));
		assert.deepEqual(r.hosts, ['data.chc.ucsb.edu']);
		assert.equal(r.problems.length, 1);
		assert.match(r.problems[0], /can't read the FEED_HOSTS entry `\.\.\.MORE_HOSTS`/);
	});

	it("fails a constant it can't resolve", () => {
		const r = feedHosts(reader(files('new URL(NOWHERE).host')));
		assert.match(r.problems[0], /can't resolve NOWHERE/);
	});

	it('fails when FEED_HOSTS or its file is gone', () => {
		assert.match(feedHosts(reader({ 'backend/src/feeds/http.ts': 'export const OTHER = [];' })).problems[0], /has no `export const FEED_HOSTS/);
		assert.match(feedHosts(reader({})).problems[0], /is gone/);
	});
});

describe('configSources', () => {
	it('reads the FEED_SOURCES tuple', () => {
		const read = reader({ 'backend/src/feeds/config.ts': "export const FEED_SOURCES = ['chirps', 'chirps_gefs', 'dws'] as const;" });
		assert.deepEqual(configSources(read), ['chirps', 'chirps_gefs', 'dws']);
	});

	it('is null when the tuple is gone', () => {
		assert.equal(configSources(reader({ 'backend/src/feeds/config.ts': 'export const X = 1;' })), null);
	});
});

describe('migrationSources', () => {
	const create = "CREATE TABLE data_feed (\n\tid uuid PRIMARY KEY,\n\tsource text NOT NULL CHECK (source IN ('chirps', 'chirps_gefs', 'dws')),\n\tsource_etag text CHECK (char_length(source_etag) < 9)\n);";

	it("reads the CREATE TABLE's check", () => {
		assert.deepEqual(migrationSources([{ name: '018.sql', text: create }]), { file: '018.sql', values: ['chirps', 'chirps_gefs', 'dws'] });
	});

	it('takes the latest definition: a later ALTER TABLE, in either form Postgres writes', () => {
		const files = [
			{ name: '018.sql', text: create },
			{ name: '300.sql', text: "ALTER TABLE data_feed DROP CONSTRAINT data_feed_source_check;\nALTER TABLE data_feed ADD CONSTRAINT data_feed_source_check CHECK (source = ANY (ARRAY['chirps'::text, 'ecmwf_ens'::text]));" }
		];
		assert.deepEqual(migrationSources(files), { file: '300.sql', values: ['chirps', 'ecmwf_ens'] });
	});

	it('reads a DROP and ADD in one ALTER TABLE statement (253_feed_source_ecmwf.sql)', () => {
		const files = [
			{ name: '018.sql', text: create },
			{
				name: '253.sql',
				text: "-- a comment with source IN ('x')\nALTER TABLE data_feed\n\tDROP CONSTRAINT data_feed_source_check,\n\tADD CONSTRAINT data_feed_source_check CHECK (source IN ('chirps', 'chirps_gefs', 'dws', 'ecmwf_ens'));"
			}
		];
		assert.deepEqual(migrationSources(files), { file: '253.sql', values: ['chirps', 'chirps_gefs', 'dws', 'ecmwf_ens'] });
	});

	it("ignores another table's check on a source column, and comments", () => {
		const files = [
			{ name: '018.sql', text: create },
			{ name: '301.sql', text: "-- ALTER TABLE data_feed ADD CHECK (source IN ('x'));\nCREATE TABLE other (source text CHECK (source IN ('y')));\nALTER TABLE data_feed ADD COLUMN note text;" }
		];
		assert.deepEqual(migrationSources(files).values, ['chirps', 'chirps_gefs', 'dws']);
	});

	it('is null when no migration sets one', () => {
		assert.equal(migrationSources([{ name: '1.sql', text: 'CREATE TABLE x (a int);' }]), null);
	});
});

describe('registerEntries', () => {
	it("reads the summary table's Hosts and Feed source columns, and nothing outside it", () => {
		const e = registerEntries(REGISTER);
		assert.deepEqual([...e.hosts], ['data.chc.ucsb.edu', 'www.dws.gov.za', 'data.bris.ac.uk']);
		assert.deepEqual([...e.sources], ['chirps', 'chirps_gefs', 'dws']);
	});

	it('is null without a table having both columns', () => {
		assert.equal(registerEntries('| Id | Hosts |\n| --- | --- |\n| a | `b` |'), null);
	});
});

describe('findProblems', () => {
	const ok = {
		register: REGISTER,
		hosts: ['data.chc.ucsb.edu', 'www.dws.gov.za'],
		config: ['chirps', 'chirps_gefs', 'dws'],
		migration: { file: '018.sql', values: ['dws', 'chirps', 'chirps_gefs'] }
	};

	it('passes when every host and source has a row (positive control)', () => {
		assert.deepEqual(findProblems(ok), []);
	});

	it('fails a host in FEED_HOSTS with no row', () => {
		const p = findProblems({ ...ok, hosts: [...ok.hosts, 'cds.climate.copernicus.eu'] });
		assert.equal(p.length, 1);
		assert.match(p[0], /cds\.climate\.copernicus\.eu/);
	});

	it('does not count a host named outside the table', () => {
		assert.equal(findProblems({ ...ok, hosts: ['elsewhere.example'] }).length, 1);
	});

	it('fails a feed source with no row, from either list', () => {
		const p = findProblems({ ...ok, config: [...ok.config, 'ecmwf_ens'], migration: { file: '300.sql', values: [...ok.config, 'ecmwf_ens'] } });
		assert.deepEqual(p.length, 1);
		assert.match(p[0], /'ecmwf_ens'/);
	});

	it('fails when FEED_SOURCES and the CHECK disagree', () => {
		const p = findProblems({ ...ok, config: ['chirps', 'dws'] });
		assert.equal(p.length, 1);
		assert.match(p[0], /disagree/);
	});

	it('fails when the register, its table or either source list is gone', () => {
		assert.match(findProblems({ ...ok, register: null })[0], /is gone/);
		assert.match(findProblems({ ...ok, register: '# nothing' })[0], /no summary table/);
		assert.match(findProblems({ ...ok, config: null }).join('\n'), /FEED_SOURCES/);
		assert.match(findProblems({ ...ok, migration: null }).join('\n'), /CHECK on data_feed\.source/);
	});

	it('carries the problems reading FEED_HOSTS', () => {
		assert.deepEqual(findProblems({ ...ok, hostProblems: ['x'] }), ['x']);
	});
});

describe('the real tree', () => {
	it('reads the real FEED_HOSTS and sources', () => {
		const { hosts, problems } = feedHosts();
		assert.deepEqual(problems, []);
		// Whole hostnames, compared exactly: a host that only contains one of these is a different host.
		const listed = new Set(hosts);
		for (const host of [
			'data.chc.ucsb.edu',
			'www.dws.gov.za',
			// Digital Earth Africa's bucket (Waterbodies, WOfS scenes) and its STAC search (WOfS, issue #604 R5).
			'deafrica-services.s3.af-south-1.amazonaws.com',
			'explorer.digitalearth.africa',
			// Its Sentinel-2 L2A Collection 1 and Sentinel-1 RTC buckets (issue #624).
			'deafrica-sentinel-2-l2a-c1.s3.af-south-1.amazonaws.com',
			'deafrica-sentinel-1.s3.af-south-1.amazonaws.com'
		]) assert.ok(listed.has(host), `${host} not in ${hosts.join(', ')}`);
	});

	it('has a register row for every live host and every data_feed.source', () => {
		assert.deepEqual(check(), []);
	});
});
