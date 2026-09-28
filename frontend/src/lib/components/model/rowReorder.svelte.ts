// Pointer drag-to-reorder for table rows (mouse and touch), shared by the
// Network table and the Crops tables. Rows carry data-idx="<position>" inside
// the tbody; the ↑/↓ buttons in MoveControls are the keyboard path.
export class RowReorder {
	/** Row being dragged and the position it would be inserted before (count = after the last). */
	drag = $state<{ id: string; insertAt: number } | null>(null);
	body: HTMLElement | undefined = $state();

	constructor(
		private readonly ids: () => string[],
		private readonly commit: (from: number, to: number, id: string) => void
	) {}

	down = (e: PointerEvent, id: string) => {
		if (e.button !== 0) return;
		e.preventDefault();
		(e.currentTarget as Element).setPointerCapture?.(e.pointerId);
		this.drag = { id, insertAt: this.ids().indexOf(id) };
	};

	move = (e: PointerEvent) => {
		if (!this.drag || !this.body) return;
		const rows = [...this.body.querySelectorAll<HTMLElement>('tr[data-idx]')];
		let at = rows.length;
		for (const r of rows) {
			const b = r.getBoundingClientRect();
			if (e.clientY < b.top + b.height / 2) {
				at = Number(r.dataset.idx);
				break;
			}
		}
		this.drag.insertAt = at;
	};

	up = () => {
		const d = this.drag;
		this.drag = null;
		if (!d) return;
		const from = this.ids().indexOf(d.id);
		const to = targetIndex(from, d.insertAt);
		if (from >= 0 && to !== from) this.commit(from, to, d.id);
	};

	cancel = () => {
		this.drag = null;
	};

	/** Classes for a row: being dragged / drop indicator above / below. */
	rowState(id: string, i: number, count: number) {
		const d = this.drag;
		return {
			dragging: d?.id === id,
			before: !!d && d.insertAt === i,
			after: !!d && d.insertAt === count && i === count - 1
		};
	}
}

/** Final index of an item at `from` inserted before position `insertAt` (of the original list). */
export function targetIndex(from: number, insertAt: number): number {
	return insertAt > from ? insertAt - 1 : insertAt;
}

/** After a ↑/↓ move re-renders, put focus back on the same button (or its twin at the list's end). */
export async function refocusMover(idPrefix: string, id: string, dir: 'up' | 'down') {
	const { tick } = await import('svelte');
	await tick();
	const want = document.getElementById(`${idPrefix}-${dir}-${id}`) as HTMLButtonElement | null;
	const other = document.getElementById(`${idPrefix}-${dir === 'up' ? 'down' : 'up'}-${id}`) as HTMLButtonElement | null;
	(want && !want.disabled ? want : other)?.focus();
}
