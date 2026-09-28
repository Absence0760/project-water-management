// The SES transport against a mocked SDK: checks the SendEmail request shape
// (no AWS account needed). Separate file because vi.mock is module-wide.
import { afterEach, describe, expect, it, vi } from 'vitest';

const sent: unknown[] = [];
vi.mock('@aws-sdk/client-sesv2', () => ({
	SESv2Client: class {
		send(cmd: { input: unknown }) {
			sent.push(cmd.input);
			return Promise.resolve({ MessageId: 'test' });
		}
	},
	SendEmailCommand: class {
		constructor(readonly input: unknown) {}
	}
}));

const { sendMail } = await import('./transport.js');

afterEach(() => vi.unstubAllEnvs());

describe('SES transport', () => {
	it('sends a simple UTF-8 message with text + HTML bodies from MAIL_FROM', async () => {
		vi.stubEnv('MAIL_TRANSPORT', 'ses');
		vi.stubEnv('MAIL_FROM', 'Water Management <no-reply@water-management.jaredhoward.com>');
		vi.stubEnv('SES_CONFIGURATION_SET', 'water-management');
		await sendMail({ to: 'ann@example.com', subject: 'Line\nbreak', text: 'plain', html: '<p>rich</p>' });
		expect(sent).toEqual([
			{
				FromEmailAddress: 'Water Management <no-reply@water-management.jaredhoward.com>',
				Destination: { ToAddresses: ['ann@example.com'] },
				ConfigurationSetName: 'water-management',
				Content: {
					Simple: {
						Subject: { Data: 'Line break', Charset: 'UTF-8' },
						Body: { Text: { Data: 'plain', Charset: 'UTF-8' }, Html: { Data: '<p>rich</p>', Charset: 'UTF-8' } }
					}
				}
			}
		]);
	});
});
