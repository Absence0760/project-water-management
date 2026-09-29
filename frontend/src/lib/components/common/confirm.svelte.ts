// The app's confirmation question (issue #162 item 21), in place of the
// browser's `confirm()` box: the same Dialog as the rest of the app, with the
// app's words on the buttons and, for the leave guard, where you are going.
// One host (ConfirmHost, mounted once in the root layout) shows the questions
// in the order they are asked; `confirmDialog` answers true for the confirm
// button and false for Cancel, Escape or the close button.
//
// `window.confirm` is banned in app code (lib/noBrowserConfirm.test.ts).

export interface ConfirmOptions {
	/** The dialog's heading: the question in a few words ("Delete run?"). */
	title: string;
	/** The detail under it: what happens, what is lost. */
	message?: string;
	/** The confirm button's words; name the action ("Delete run"), not "OK". */
	confirmLabel?: string;
	/** The other button's words (default "Cancel"). */
	cancelLabel?: string;
	/** A destructive action: the confirm button is drawn red. */
	danger?: boolean;
}

export interface ConfirmRequest extends ConfirmOptions {
	id: number;
	resolve: (ok: boolean) => void;
}

class ConfirmQueue {
	/** The questions waiting, the one on screen first. */
	items = $state.raw<ConfirmRequest[]>([]);
}

export const confirmQueue = new ConfirmQueue();
let nextId = 1;

/** Ask the question in the app's dialog; true when the person confirms. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
	return new Promise((resolve) => {
		confirmQueue.items = [...confirmQueue.items, { ...options, id: nextId++, resolve }];
	});
}

/** Answer the question with this id (the host's buttons); the next one, if any, shows. */
export function answerConfirm(id: number, ok: boolean): void {
	const req = confirmQueue.items.find((r) => r.id === id);
	if (!req) return;
	confirmQueue.items = confirmQueue.items.filter((r) => r.id !== id);
	req.resolve(ok);
}
