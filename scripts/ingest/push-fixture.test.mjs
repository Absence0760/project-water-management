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

test('refuses an impossible calendar date instead of rolling it into the next month', () => {
	assert.throws(() => parseCsv('2024-02-31,1\n2024-03-01,2\n'), /line 1: "2024-02-31" is not a calendar date/);
	assert.throws(() => parseCsv('2023-02-29,1\n'), /not a calendar date/);
	// Positive control: a leap day is a day.
	assert.deepEqual(parseCsv('2024-02-29,1\n2024-03-01,2\n'), { startDate: '2024-02-29', values: [1, 2] });
});

test('refuses a day given twice, and a value that is not a plain decimal; rows may come in any order', () => {
	assert.throws(() => parseCsv('2024-01-01,1\n2024-01-01,5\n'), /line 2: 2024-01-01 appears more than once/);
	assert.throws(() => parseCsv('2024-01-01,0x10\n'), /"0x10" is not a number/);
	assert.throws(() => parseCsv('2024-01-01,1e999\n'), /not a number/);
	assert.deepEqual(parseCsv('2024-01-03,1\n2024-01-01,-2.5e-1\n2024-01-02,.5\n'), { startDate: '2024-01-01', values: [-0.25, 0.5, 1] });
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
