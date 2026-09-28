// The ingest push script's pure helpers (scripts/ingest/push-fixture.mjs).
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseCsv, readEnv, redate } from './push-fixture.mjs';

test('parses date,value rows into one run of days, gaps and blanks as null, skipping the header and comments', () => {
	const s = parseCsv('date,value\n# note\n2024-01-01,1.5\n2024-01-02,\n2024-01-04,3\n');
	assert.deepEqual(s, { startDate: '2024-01-01', values: [1.5, null, null, 3] });
});

test('refuses a bad date or value after the header, and an empty file', () => {
	assert.throws(() => parseCsv('date,value\n2024-13,1\n'), /line 2/);
	assert.throws(() => parseCsv('2024-01-01,abc\n'), /not a number/);
	assert.throws(() => parseCsv('date,value\n'), /no rows/);
});

test('re-dates a run so its last day is the one given, across a month end', () => {
	assert.deepEqual(redate({ startDate: '2024-01-01', values: [1, 2, 3] }, '2024-03-01'), { startDate: '2024-02-28', values: [1, 2, 3] });
});

test('reads the key from the environment first, then from the local env file; the API defaults to :3001', () => {
	const dir = mkdtempSync(join(tmpdir(), 'ingest-'));
	const file = join(dir, '.env.development.local');
	writeFileSync(file, 'OTHER=1\nWM_INGEST_KEY="wm_from_file"\nWM_API_URL=http://localhost:3999/\n');
	assert.deepEqual(readEnv({}, file), { key: 'wm_from_file', api: 'http://localhost:3999' });
	assert.deepEqual(readEnv({ WM_INGEST_KEY: 'wm_env' }, file), { key: 'wm_env', api: 'http://localhost:3999' });
	assert.deepEqual(readEnv({}, join(dir, 'missing')), { key: '', api: 'http://localhost:3001' });
});
