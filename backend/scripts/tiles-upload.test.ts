// The local basemap upload (tiles-upload.ts): the URLs it prints for the
// frontend (basemap, relief, glyphs), and which files of a fonts directory become glyph objects
// (#326 A6): only `<fontstack>/<n>-<n+255>.pbf` and the licence.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fontObjects, glyphsUrl, isRangeFile, publicReadPolicy, terrainUrl, tilesUrl } from './tiles-upload.js';

describe('tiles-upload', () => {
	it('prints localhost URLs for the tiles and the glyphs, braces kept for MapLibre', () => {
		expect(tilesUrl('http://127.0.0.1:9002/')).toBe('http://localhost:9002/tiles/south-africa.pmtiles');
		expect(glyphsUrl('http://127.0.0.1:9002')).toBe('http://localhost:9002/tiles/fonts/{fontstack}/{range}.pbf');
		expect(terrainUrl('http://127.0.0.1:9002')).toBe('http://localhost:9002/tiles/terrain.pmtiles');
	});

	it('lets anyone GET an object and nothing else', () => {
		expect(JSON.parse(publicReadPolicy()).Statement).toEqual([{ Effect: 'Allow', Principal: { AWS: ['*'] }, Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::tiles/*'] }]);
	});

	it('takes glyph ranges as MapLibre names them, and nothing else', () => {
		expect(isRangeFile('0-255.pbf')).toBe(true);
		expect(isRangeFile('65280-65535.pbf')).toBe(true);
		expect(isRangeFile('1-256.pbf')).toBe(false);
		expect(isRangeFile('0-511.pbf')).toBe(false);
		expect(isRangeFile('0-255.pbf.bak')).toBe(false);
	});

	it('uploads each font stack’s ranges and the licence, under fonts/, skipping stray files', () => {
		const dir = mkdtempSync(join(tmpdir(), 'wm-fonts-'));
		mkdirSync(join(dir, 'Noto Sans Regular'));
		mkdirSync(join(dir, 'Noto Sans Italic'));
		for (const f of ['0-255.pbf', '256-511.pbf', 'README.md']) writeFileSync(join(dir, 'Noto Sans Regular', f), 'x');
		writeFileSync(join(dir, 'Noto Sans Italic', '0-255.pbf'), 'x');
		writeFileSync(join(dir, 'OFL.txt'), 'licence');
		writeFileSync(join(dir, 'notes.txt'), 'stray');
		expect(fontObjects(dir).map((o) => [o.key, o.contentType])).toEqual([
			['fonts/Noto Sans Italic/0-255.pbf', 'application/x-protobuf'],
			['fonts/Noto Sans Regular/0-255.pbf', 'application/x-protobuf'],
			['fonts/Noto Sans Regular/256-511.pbf', 'application/x-protobuf'],
			['fonts/OFL.txt', 'text/plain; charset=utf-8']
		]);
	});
});
