// "Explain each setting under its field" (issue #468): one remembered switch
// for every form that hides its explanations, so ticking it in Settings, a
// node's sheet or the scenario editor holds in the others. Off by default, so
// the fields come first; each field keeps its ⓘ, and the hidden `.explain`
// text stays its description for screen readers (aria-describedby reads
// hidden text). Remembered on this device; in private mode, for this visit.
// ExplainSwitch.svelte draws the checkbox; a form marks its wrapper
// `class="explain-scope" class:explained={explainSwitch.on}`, and app.css's
// one rule hides the `.explain` text under it while the switch is off.

export const EXPLAIN_KEY = 'wm.settings.explain';

function read(): boolean {
	try {
		return localStorage.getItem(EXPLAIN_KEY) === '1';
	} catch {
		return false;
	}
}

let on = $state(read());

export const explainSwitch = {
	get on(): boolean {
		return on;
	},
	set(next: boolean): void {
		on = next;
		try {
			localStorage.setItem(EXPLAIN_KEY, next ? '1' : '0');
		} catch {
			// Private mode: it holds for this visit.
		}
	}
};
