import { beforeEach, describe, expect, it } from 'vitest';
import { sheetFolds } from './sheetFolds.svelte';

const SECTIONS = ['area', 'share', 'dam'];
const KEYS = [...SECTIONS, 'more:dam'];

describe('sheetFolds', () => {
	beforeEach(() => {
		sheetFolds.open = [];
		sheetFolds.setAll(false);
	});

	it('opens a sheet on its first section, and keeps an open section across nodes', () => {
		sheetFolds.start(SECTIONS);
		expect(SECTIONS.filter((s) => sheetFolds.isOpen(s))).toEqual(['area']);
		sheetFolds.only('dam', SECTIONS);
		// The next unit (‹ ›): its dam stays open.
		sheetFolds.start(SECTIONS);
		expect(SECTIONS.filter((s) => sheetFolds.isOpen(s))).toEqual(['dam']);
	});

	it('jumps to one section, closing the other sections but keeping their folds', () => {
		sheetFolds.start(SECTIONS);
		sheetFolds.toggled('share', true, KEYS);
		sheetFolds.toggled('more:dam', true, KEYS);
		sheetFolds.only('dam', SECTIONS);
		expect(KEYS.filter((k) => sheetFolds.isOpen(k))).toEqual(['dam', 'more:dam']);
	});

	it('shows every field, and closing one then leaves the rest open', () => {
		sheetFolds.setAll(true);
		expect(KEYS.every((k) => sheetFolds.isOpen(k))).toBe(true);
		sheetFolds.toggled('share', false, KEYS);
		expect(sheetFolds.all).toBe(false);
		expect(KEYS.filter((k) => sheetFolds.isOpen(k))).toEqual(['area', 'dam', 'more:dam']);
		// A jump while every field shows leaves them open.
		sheetFolds.setAll(true);
		sheetFolds.only('dam', SECTIONS);
		expect(KEYS.every((k) => sheetFolds.isOpen(k))).toBe(true);
	});
});
