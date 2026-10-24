// The Map's search box's state (issue #523 C5; docs/maps.md § Search, the
// component MapSearch.svelte): what was found, whether the list is open, the
// match the view moved to, the live line, and the places' credit. Kept apart
// from the markup so the flow is tested without a DOM
// (mapSearchState.svelte.test.ts).
import type { MapSearchAnswer, MapSearchHit } from '#lib/api/types.js';
import { hitName, placeCredits, resultLine } from './mapSearch';

export class MapSearchState {
	busy = $state(false);
	error = $state<string | null>(null);
	answer = $state<MapSearchAnswer | null>(null);
	/** The list is showing (a search with several matches, until one is picked or Escape). */
	open = $state(false);
	/** The match the view moved to. */
	shown = $state<MapSearchHit | null>(null);
	/**
	 * The credit of every place the current answer holds (GeoNames' CC BY 4.0
	 * attribution in production), shown whether the list is open or not: a
	 * single place is picked at once and never listed, and its credit still
	 * shows.
	 */
	credits = $derived(this.answer ? placeCredits(this.answer.hits) : []);
	/** Said to assistive technology after each search and each pick. */
	said = $derived(
		this.error
			? ''
			: this.busy
				? 'Searching…'
				: this.shown
					? `Showing ${hitName(this.shown)} on the map.`
					: this.answer
						? resultLine(this.answer.q, this.answer.hits, this.answer.truncated, this.answer.placesLoaded)
						: ''
	);

	constructor(
		private readonly search: (q: string) => Promise<MapSearchAnswer>,
		private readonly onpick: (hit: MapSearchHit) => void
	) {}

	/** Move the view to `h` and close the list. */
	pick(h: MapSearchHit) {
		this.shown = h;
		this.open = false;
		this.onpick(h);
	}

	/** Search for `q`: one match moves the view at once, several open the list. */
	async find(q: string) {
		const text = q.trim();
		this.error = null;
		this.shown = null;
		if (text.length < 2) {
			this.error = 'Type at least 2 letters or digits.';
			return;
		}
		this.busy = true;
		try {
			const answer = await this.search(text);
			this.answer = answer;
			if (answer.hits.length === 1) this.pick(answer.hits[0]!);
			else this.open = answer.hits.length > 0;
		} catch (err) {
			this.answer = null;
			this.open = false;
			this.error = `The search failed: ${(err as Error).message}`;
		} finally {
			this.busy = false;
		}
	}

	/** Escape: close the list; true when there was one to close. */
	close(): boolean {
		if (!this.open) return false;
		this.open = false;
		return true;
	}
}
