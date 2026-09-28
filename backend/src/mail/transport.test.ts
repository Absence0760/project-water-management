import { afterEach, describe, expect, it, vi } from 'vitest';
import { oneLine, outbox, safeHeaders, sendMail, trySendMail } from './transport.js';

const mail = { to: 'ann@example.com', subject: 'Hello', text: 'secret link ?token=abc', html: '<p>hi</p>' };

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	outbox.length = 0;
});

describe('mail transport', () => {
	it('memory transport collects messages', async () => {
		vi.stubEnv('MAIL_TRANSPORT', 'memory');
		await sendMail(mail);
		expect(outbox).toEqual([mail]);
	});

	it('passes extra headers on one line each, and refuses a header name that isn’t a token (alert mails, RFC 8058)', async () => {
		vi.stubEnv('MAIL_TRANSPORT', 'memory');
		await sendMail({ ...mail, headers: { 'List-Unsubscribe': '<https://x/a?token=t>\r\nBcc: evil@example.com', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } });
		expect(outbox[0]!.headers).toEqual({ 'List-Unsubscribe': '<https://x/a?token=t> Bcc: evil@example.com', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
		expect(() => safeHeaders({ 'Bad\r\nName': 'x' })).toThrow(/not a header name/);
		expect(() => safeHeaders({ 'X: y': 'x' })).toThrow(/not a header name/);
		expect(safeHeaders(undefined)).toBeUndefined();
	});

	it('defaults to the log transport, which prints the message locally', async () => {
		vi.stubEnv('MAIL_TRANSPORT', '');
		vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', '');
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		await sendMail(mail);
		expect(info.mock.calls[0]![0]).toContain('secret link');
	});

	it('the log transport never prints message bodies inside Lambda', async () => {
		vi.stubEnv('MAIL_TRANSPORT', 'log');
		vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'water-management-api');
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await sendMail(mail);
		expect(info).not.toHaveBeenCalled();
		expect(warn.mock.calls.flat().join(' ')).not.toContain('token');
	});

	it('rejects an unknown transport, and trySendMail reports failure without the body', async () => {
		vi.stubEnv('MAIL_TRANSPORT', 'carrier-pigeon');
		await expect(sendMail(mail)).rejects.toThrow(/unknown MAIL_TRANSPORT/);
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(await trySendMail(mail)).toBe(false);
		expect(error.mock.calls.flat().join(' ')).not.toContain('secret link');
	});

	it('refuses half an SMTP credential', async () => {
		vi.stubEnv('MAIL_TRANSPORT', 'smtp');
		vi.stubEnv('SMTP_USER', 'someone');
		vi.stubEnv('SMTP_PASSWORD', '');
		await expect(sendMail(mail)).rejects.toThrow(/SMTP_USER and SMTP_PASSWORD/);
	});

	it('oneLine strips header-injection line breaks', () => {
		expect(oneLine('Hi\r\nBcc: evil@example.com')).toBe('Hi Bcc: evil@example.com');
	});
});
