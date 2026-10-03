// Sub-catchments from clicks on the rivers (docs/maps.md § Sub-catchments
// from clicks, docs/ui.md § Map). Each click is an outlet; the server answers
// with each click's incremental catchment (the land draining to it before any
// other click), and the map draws them piece by piece, numbered by click. The
// clicks live here until they are saved as areas or dropped: nothing is
// stored on the server before Save, which routes the same clicks again.
//
// Each change of the clicks is one request (and one count against the
// account's hourly cap on elevation-model work), so Undo goes back to the
// answer it had rather than asking again, and a click the server refuses
// (off the elevation model, a catchment too large) is taken back with the
// reason, so the clicks before it keep working.
import type { ClickPieces, MapFeature, MapPosition } from '$lib/api/types';
import { confluenceOf, largerLine } from './largerChannel';
import type { ConfluenceChoice } from '$lib/api/types';
import { interiorPoint, pieceTintsFor, type PiecesShape, type ProposalPiece } from './pieces';

/** The map's shape for an answer: one piece per click, numbered by click, the lowest click as the outlet and every kept click marked. Pure. */
export function clickShape(r: ClickPieces | null, highlight: string | null = null): (PiecesShape & { outlets: MapPosition[] }) | null {
	if (!r?.pieces.length) return null;
	const lowest = r.pieces.find((p) => p.click === r.lowest);
	const tints = pieceTintsFor(r.pieces.map((p) => p.geometry));
	const pieces: ProposalPiece[] = r.pieces.map((p, i) => ({
		key: String(p.click),
		label: String(p.click + 1),
		name: `Sub-catchment ${p.click + 1}`,
		geometry: p.geometry,
		at: (p.geometry && interiorPoint(p.geometry)) ?? p.point,
		tint: tints[i]!
	}));
	const polys = r.pieces.flatMap((p) => (p.geometry ? [p.geometry.coordinates] : []));
	if (!polys.length || !lowest) return null;
	return {
		// One id for every answer: the map frames a proposal once per id, so it frames the first pieces and then stays where the editor is clicking.
		id: 'clicks',
		geometry: { type: 'MultiPolygon', coordinates: polys },
		outlet: lowest.point,
		outlets: r.pieces.filter((p) => p !== lowest).map((p) => p.point),
		pieces,
		highlight
	};
}

/**
 * Under this much upstream (m²), a click has almost surely missed the channel: the server snaps within about 150 m, and a
 * river line can sit further off the channel the elevation model sees (HydroRIVERS by a few hundred metres, measured on the Orange).
 */
export const MISSED_M2 = 1e6;
const MISSED = 'very little drains here: it probably missed the channel; Undo and click closer to the river (the Relief layer shows the valley)';
const missed = (p: { open: boolean; totalAreaM2: number | null }) => !p.open && p.totalAreaM2 !== null && p.totalAreaM2 < MISSED_M2;

/** What a piece's line says: its area, and where its water goes next. */
export function pieceLine(r: ClickPieces, click: number): string {
	const p = r.pieces.find((x) => x.click === click);
	if (!p) {
		const d = r.dropped.find((x) => x.click === click);
		return d ? `not a piece: it ${d.reason}` : 'not a piece';
	}
	const km2 = (m2: number) => `${(m2 / 1e6).toFixed(2)} km²`;
	const into = p.drainsInto === null ? 'the lowest point: the rest drains out here' : `drains into ${p.drainsInto + 1}`;
	if (p.open || p.areaM2 === null) return `an inflow point: its catchment runs past the area routed around the clicks, so no piece; the water from above it enters ${p.drainsInto === null ? 'here' : `${p.drainsInto + 1}`} as an inflow`;
	const inflows = r.pieces.filter((q) => q.open && q.drainsInto === p.click).map((q) => q.click + 1);
	const upstream = p.totalAreaM2 === null ? ' · more upstream than was routed' : p.drainsInto !== null || r.pieces.length > 1 ? ` · ${km2(p.totalAreaM2)} upstream in all` : '';
	const placed = !p.reach
		? ''
		: p.placedBy === 'junction'
			? ` · at the elevation model’s junction, on river reach ${p.reach.reachId} (${km2(p.reach.upstreamKm2 * 1e6)})`
			: ` · on the channel matching river reach ${p.reach.reachId} (${km2(p.reach.upstreamKm2 * 1e6)})`;
	const moved = p.snapDistanceM !== null && p.snapDistanceM >= 50 ? ` · moved ${Math.round(p.snapDistanceM)} m to the channel` : '';
	// A larger channel nearby explains a small piece better than the other warnings do.
	const warn = p.larger
		? ` · ${largerLine(p.point, p.larger)}`
		: p.unmatched
			? ` · river reach ${p.unmatched.reachId} nearby drains ${km2(p.unmatched.upstreamKm2 * 1e6)}, and no channel near the click matches it: check it is the right stream`
			: missed(p)
				? ` · ${MISSED}`
				: '';
	// What of its own area drains into pans (start-10): reported, still in the area.
	const pans = p.nonContributingM2 ? ` · ${km2(p.nonContributingM2)} of it drains into pans (non-contributing)` : '';
	return `${km2(p.areaM2)} · ${into}${upstream}${pans}${inflows.length ? ` · an inflow enters at ${inflows.join(' and ')}` : ''}${placed}${moved}${warn}`;
}

/** The pieces Save keeps: whole and outlined. */
export const savable = (r: ClickPieces | null) => (r ? r.pieces.filter((p) => !p.open && p.geometry && p.areaM2 !== null) : []);

/** A click; `reach` is the river it means, picked at a confluence. */
type Click = { lon: number; lat: number; reach?: { dataset: string; reachId: number } };
type Fetch = (clicks: Click[]) => Promise<ClickPieces>;
type Save = (clicks: Click[]) => Promise<{ features: MapFeature[]; summary: string }>;

export class ClickDivider {
	/** The clicks, in order: the badges' numbers are their places here, plus one. */
	clicks = $state.raw<Click[]>([]);
	/** The server's answer for `clicks`; null with none, or while the first is on its way. */
	result = $state.raw<ClickPieces | null>(null);
	busy = $state<null | 'pieces' | 'save'>(null);
	error = $state<string | null>(null);
	/** The last change, for a polite live region. */
	said = $state('');
	/** A click held back at a confluence: the clicks it would make and which one it is, and the rivers to pick from. */
	pendingChoice = $state.raw<{ clicks: Click[]; click: number; choices: ConfluenceChoice[] } | null>(null);
	/** The answers before each click, for Undo without asking again. */
	#history: { clicks: Click[]; result: ClickPieces | null }[] = [];
	#seq = 0;
	readonly #fetch: Fetch;
	readonly #save: Save;

	constructor(fetch: Fetch, save: Save) {
		this.#fetch = fetch;
		this.#save = save;
	}

	get canUndo() {
		return this.#history.length > 0 && this.busy !== 'save';
	}
	get unsaved() {
		return this.clicks.length > 0;
	}

	/** A click on the map (or typed): routed with the others; refused, it is taken back with the reason. */
	async add(at: MapPosition) {
		if (this.busy === 'save') return;
		await this.#route([...this.clicks, { lon: at[0], lat: at[1] }], this.clicks.length);
	}

	/** Move click `i` to `at` (the larger channel its piece names), routed again; Undo moves it back. */
	async replace(i: number, at: MapPosition) {
		if (this.busy === 'save' || !this.clicks[i]) return;
		await this.#route(
			this.clicks.map((c, k) => (k === i ? { lon: at[0], lat: at[1] } : c)),
			i
		);
	}

	/** The river picked for the click held at a confluence: routed with it. */
	async chooseReach(choice: Pick<ConfluenceChoice, 'dataset' | 'reachId'>) {
		const p = this.pendingChoice;
		if (!p || this.busy === 'save') return;
		this.pendingChoice = null;
		await this.#route(
			p.clicks.map((c, k) => (k === p.click ? { ...c, reach: { dataset: choice.dataset, reachId: choice.reachId } } : c)),
			p.click
		);
	}

	/** Drop the click held at a confluence. */
	cancelChoice() {
		this.pendingChoice = null;
		this.said = 'Dropped the click at the confluence.';
	}

	/** Route `clicks`, `changed` the index of the click that is new or moved (its piece is what the live line reports). */
	async #route(clicks: Click[], changed: number) {
		this.pendingChoice = null;
		const before = { clicks: this.clicks, result: this.result };
		this.clicks = clicks;
		this.error = null;
		this.busy = 'pieces';
		this.said = `Click ${changed + 1}: working out the sub-catchments…`;
		const seq = ++this.#seq;
		try {
			const r = await this.#fetch(clicks);
			if (seq !== this.#seq) return;
			this.#history.push(before);
			this.result = r;
			const dropped = r.dropped.find((d) => d.click === changed);
			const newest = r.pieces.find((p) => p.click === changed);
			const whole = r.pieces.filter((p) => !p.open).length;
			const open = r.pieces.length - whole;
			this.said = dropped
				? `Click ${changed + 1} is not a piece: it ${dropped.reason}.`
				: newest?.larger
					? `Click ${changed + 1}: ${largerLine(newest.point, newest.larger)}.`
					: newest && missed(newest)
						? `Click ${changed + 1}: ${MISSED}.`
						: `${whole === 1 ? '1 sub-catchment' : `${whole} sub-catchments`}${open ? `, ${open === 1 ? '1 inflow point' : `${open} inflow points`}` : ''}.`;
		} catch (err) {
			if (seq !== this.#seq) return;
			// Taken back: the clicks before it still divide as they did.
			this.clicks = before.clicks;
			this.result = before.result;
			// At a confluence the click waits for the editor to pick the river (chooseReach), not refused.
			const junction = confluenceOf(err);
			if (junction && junction.click !== null) {
				this.pendingChoice = { clicks, click: junction.click, choices: junction.choices };
				this.error = null;
				this.said = `Click ${junction.click + 1} is at a confluence: pick the river you mean.`;
				return;
			}
			this.error = `${changed === clicks.length - 1 && clicks.length > before.clicks.length ? 'Click not added' : `Click ${changed + 1} not moved`}: ${err instanceof Error ? err.message : String(err)}`;
			this.said = this.error;
		} finally {
			if (seq === this.#seq) this.busy = null;
		}
	}

	undo() {
		this.pendingChoice = null;
		const prev = this.#history.pop();
		if (!prev) return;
		this.#seq++;
		this.busy = null;
		this.error = null;
		const moved = prev.clicks.length === this.clicks.length;
		this.clicks = prev.clicks;
		this.result = prev.result;
		this.said = moved ? 'Moved the click back.' : this.clicks.length ? `Took back click ${this.clicks.length + 1}.` : 'Took back the click; none left.';
	}

	clear() {
		this.#seq++;
		this.pendingChoice = null;
		this.#history = [];
		this.clicks = [];
		this.result = null;
		this.busy = null;
		this.error = null;
		this.said = '';
	}

	/** Save every piece as an area; the clicks are cleared once saved. */
	async save(): Promise<{ features: MapFeature[]; summary: string } | null> {
		if (!savable(this.result).length || this.busy) return null;
		this.busy = 'save';
		this.error = null;
		try {
			const r = await this.#save(this.clicks);
			this.clear();
			return r;
		} catch (err) {
			this.error = err instanceof Error ? err.message : String(err);
			return null;
		} finally {
			this.busy = null;
		}
	}
}
