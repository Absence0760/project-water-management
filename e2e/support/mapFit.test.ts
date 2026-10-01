// The map's layout-settled check (support/mapFit.ts, issue #138). Run by
// `pnpm -C e2e test` (node:test).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapFitSettled, type MapFitReading } from './mapFit.ts';

const settled: MapFitReading = { fit: '358x612', width: 358, height: 612, wide: false, mapTop: '184.5px', top: 184.5, busy: false };

test('settled when the drawing was laid out for the box, breakpoint and map top of this moment', () => {
	assert.equal(mapFitSettled(settled), true);
	assert.equal(mapFitSettled({ ...settled, fit: '1020x700 wide', width: 1020, height: 700, wide: true }), true);
});

test('not settled while the drawing still has the old width, height or breakpoint', () => {
	// Straight after 1280 → 390: the box is narrow, the drawing still the wide one.
	assert.equal(mapFitSettled({ ...settled, fit: '1020x700 wide' }), false);
	assert.equal(mapFitSettled({ ...settled, fit: '358x700' }), false);
	// The box re-measured, the breakpoint's change event not yet in.
	assert.equal(mapFitSettled({ ...settled, fit: '358x612 wide' }), false);
	assert.equal(mapFitSettled({ ...settled, fit: null }), false);
});

test('not settled while the Map layout is still sized from its old top', () => {
	assert.equal(mapFitSettled({ ...settled, mapTop: '140px' }), false);
	assert.equal(mapFitSettled({ ...settled, mapTop: null }), false);
});

test('a drawing outside the Map layout (the report) needs only its own box', () => {
	assert.equal(mapFitSettled({ ...settled, mapTop: null, top: null }), true);
});

test('not settled while the map card is busy: its loading line can still move the map when it goes', () => {
	// Droëvlei at 1280 × 800: the run's results landed between reading the box and reading the labels.
	assert.equal(mapFitSettled({ ...settled, busy: true }), false);
	assert.equal(mapFitSettled({ ...settled, mapTop: null, top: null, busy: true }), false);
});
