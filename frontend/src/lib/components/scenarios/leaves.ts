// When a navigation drops work that belongs to one scenario (override mode's
// edits, a half-filled change or rename; lib/nav/unsaved.ts): leaving the
// page, the Scenarios tab or this scenario. Other URL parameters (a chart's
// range, the new-scenario dialog) keep it.
export function leavesScenario(from: URL, to: URL): boolean {
	return to.pathname !== from.pathname || ['tab', 'scenario'].some((k) => to.searchParams.get(k) !== from.searchParams.get(k));
}

/** The Scenarios tab's own work (the New scenario dialog): leaving the page or the tab drops it. */
export function leavesScenariosTab(from: URL, to: URL): boolean {
	return to.pathname !== from.pathname || to.searchParams.get('tab') !== from.searchParams.get('tab');
}
