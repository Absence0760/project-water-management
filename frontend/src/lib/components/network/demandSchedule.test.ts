import { DEMAND_SCHEDULE_SPANS, scheduleWindowProblem } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { moveWindow, newWindow, SPAN_LABEL, toggleWeekday, withSpan } from './demandSchedule';

describe('newWindow', () => {
	it('labels every span the engine knows', () => {
		expect(Object.keys(SPAN_LABEL).sort()).toEqual([...DEMAND_SCHEDULE_SPANS].sort());
		// The span that takes weekday ticks says so, so a weekly on/off pattern is findable (#342 item 4).
		expect(SPAN_LABEL.always).toBe('Days of the week');
	});
	it('starts each span off, and every one but the blank date range runs as it stands', () => {
		for (const span of DEMAND_SCHEDULE_SPANS) {
			const w = newWindow(span);
			expect(w.span).toBe(span);
			expect(w.factor).toBe(0);
			if (span === 'range') expect(scheduleWindowProblem(w)).toMatch(/YYYY-MM-DD/);
			else expect(scheduleWindowProblem(w), span).toBeNull();
		}
		expect(newWindow('always').weekdays).toEqual([6, 7]);
		expect(newWindow('easter')).toMatchObject({ easterFrom: -2, easterTo: 1 });
	});
});

describe('withSpan', () => {
	it('swaps the bounds for the new span and keeps the label, weekdays and factor', () => {
		const w = { ...newWindow('always'), factor: 0.4 };
		const y = withSpan(w, 'yearly');
		expect(y).toMatchObject({ span: 'yearly', label: 'Weekends', weekdays: [6, 7], factor: 0.4, from: '12-15', to: '01-10', easterFrom: null, easterTo: null });
		expect(withSpan(y, 'easter')).toMatchObject({ from: null, to: null, easterFrom: -2, easterTo: 1, factor: 0.4 });
	});
});

describe('toggleWeekday', () => {
	it('unticks a day from every day, ticks one back, and reads all seven as no filter', () => {
		expect(toggleWeekday(null, 3, false)).toEqual([1, 2, 4, 5, 6, 7]);
		expect(toggleWeekday([6], 7, true)).toEqual([6, 7]);
		expect(toggleWeekday([1, 2, 3, 4, 5, 6], 7, true)).toBeNull();
		expect(toggleWeekday([7], 7, true)).toEqual([7]);
	});
	it('leaves an empty list when the last day is unticked, which the save refuses', () => {
		const days = toggleWeekday([6], 6, false);
		expect(days).toEqual([]);
		expect(scheduleWindowProblem({ ...newWindow('always'), weekdays: days })).toMatch(/at least one/);
	});
});

describe('moveWindow', () => {
	it('swaps a window with its neighbour, and does nothing past an end', () => {
		expect(moveWindow(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
		expect(moveWindow(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
		expect(moveWindow(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
		expect(moveWindow(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
	});
});
