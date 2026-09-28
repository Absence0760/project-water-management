// The account-mail endpoints a signed-out caller can name any address to
// (POST /auth/forgot-password, /auth/resend-confirmation) answer the same
// 202 whether or not the address has an account. The body alone isn't
// enough: awaiting the send for a known address and not for an unknown one
// made the known one ~60-100 ms slower, which told anyone timing it which
// addresses have accounts (issue #51, adversary finding 2).
//
// answerAlike makes both paths the same: the send is started and never
// awaited, and the response waits for one fixed floor measured from the
// start of the request, which covers the extra database work of a known
// address (issuing the token) as well. Caveat in Lambda: a send still in
// flight when the response goes is frozen with the environment and finishes
// at its next invocation, or is lost if the environment is retired; the
// floor gives it that long first, and a lost link is asked for again.
// docs/security.md § "Password reset, email verification and invites".
import { trySendMail, type Mail } from '../mail/transport.js';

/** The least time an account-mail answer takes, known address or not. */
export const ACCOUNT_MAIL_FLOOR_MS = 200;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface AnswerAlikeOptions {
	/** Resolves when the answer may go (default: ACCOUNT_MAIL_FLOOR_MS from the call). Started before `work`. */
	floor?: Promise<unknown>;
	/** Sends a mail (default trySendMail). Its promise is never awaited. */
	send?: (mail: Mail) => Promise<unknown>;
}

/**
 * Run `work` (the lookup and token issue; it returns the mail to send, or
 * null when there is none: an unknown address, a cooldown, the cap), start
 * that mail without waiting for it, and resolve when the floor does, never
 * earlier and never later because of the send. An error from `work` still
 * throws, with nothing sent.
 */
export async function answerAlike(
	work: () => Promise<Mail | null>,
	{ floor = sleep(ACCOUNT_MAIL_FLOOR_MS), send = trySendMail }: AnswerAlikeOptions = {}
): Promise<void> {
	const mail = await work();
	// trySendMail never rejects; the catch keeps another sender's failure off the unhandled-rejection path.
	if (mail) void send(mail).catch(() => undefined);
	await floor;
}
