// The e2e slot registry: which git worktree of this repo holds which slot
// (support/env.ts), so no two live worktrees ever get the same ports.
//
// A slot used to be a hash of the worktree's path into 1–98, and with a dozen
// worktrees at once two often landed on one slot: the second run stopped at
// start-up on a port in use. The registry lives in the repository's shared git
// directory (`git rev-parse --git-common-dir`, the main checkout's `.git`), which
// every worktree of the repo sees: a file per held slot, `<common>/water-e2e-slots/<n>`,
// holding the owner's real path. A worktree keeps its slot for good; a slot
// whose owner no longer exists (the worktree was removed) is taken back when
// a new one needs a slot. Allocation happens under a lock directory, so two
// worktrees starting at once never pick the same slot.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 15_000;

/** The repository's shared git directory for a worktree (from its `.git` file and the `commondir` beside its gitdir), or null. */
export function gitCommonDir(checkout: string): string | null {
	try {
		const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(`${checkout}/.git`, 'utf8'));
		if (!pointer) return null;
		const gitdir = resolve(checkout, (pointer[1] ?? '').trim());
		const commondir = readFileSync(`${gitdir}/commondir`, 'utf8').trim();
		return isAbsolute(commondir) ? commondir : resolve(gitdir, commondir);
	} catch {
		return null;
	}
}

function sleep(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock<T>(dir: string, fn: () => T): T {
	const lock = `${dir}/.lock`;
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			mkdirSync(lock);
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
			// A process that died holding it: the lock is only ever held for a few file operations.
			try {
				if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmdirSync(lock);
			} catch {
				// Released meanwhile.
			}
			if (Date.now() > deadline) throw new Error(`e2e: timed out waiting for the slot registry lock ${lock}; remove it if no e2e run is starting`);
			sleep(25);
		}
	}
	try {
		return fn();
	} finally {
		rmdirSync(lock);
	}
}

function holders(dir: string, slots: number): Map<number, string> {
	const held = new Map<number, string>();
	for (const f of readdirSync(dir)) {
		const n = Number(f);
		if (!/^\d+$/.test(f) || n < 1 || n >= slots) continue;
		try {
			held.set(n, readFileSync(`${dir}/${f}`, 'utf8').trim());
		} catch {
			// Taken back meanwhile.
		}
	}
	return held;
}

/**
 * The slot from 1 to slots − 1 that `checkout` holds in the registry under `dir`, taking one
 * (the free slot at or after `preferred`, wrapping) when it has none. `alive(path)` says whether
 * a holder still exists; a slot whose holder doesn't is free to take.
 */
export function claimSlot(dir: string, checkout: string, preferred: number, slots: number, alive: (path: string) => boolean = (p) => existsSync(`${p}/.git`)): number {
	mkdirSync(dir, { recursive: true });
	const mine = (held: Map<number, string>) => [...held].find(([, path]) => path === checkout)?.[0];
	const fast = mine(holders(dir, slots));
	if (fast !== undefined) return fast;
	return withLock(dir, () => {
		const held = holders(dir, slots);
		const again = mine(held);
		if (again !== undefined) return again;
		for (let i = 0; i < slots - 1; i++) {
			const n = 1 + ((preferred - 1 + i) % (slots - 1));
			const holder = held.get(n);
			if (holder !== undefined && alive(holder)) continue;
			if (holder !== undefined) unlinkSync(`${dir}/${n}`);
			const fd = openSync(`${dir}/${n}`, 'wx');
			try {
				writeSync(fd, `${checkout}\n`);
			} finally {
				closeSync(fd);
			}
			return n;
		}
		throw new Error(
			`e2e: all ${slots - 1} worktree slots in ${dir} are held by existing worktrees. Remove worktrees you no longer need (git worktree remove), or set E2E_SLOT.`
		);
	});
}

/** The registry directory for a worktree: `<git common dir>/water-e2e-slots`, or null when the common dir can't be found. */
export function registryDir(checkout: string): string | null {
	const common = gitCommonDir(checkout);
	return common && existsSync(common) ? `${common}/water-e2e-slots` : null;
}

