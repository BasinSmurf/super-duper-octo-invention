import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const gmail = vi.hoisted(() => ({
  send: vi.fn(async () => ({ data: { id: 'test-message' } })),
  token: vi.fn(async () => ({ token: 'test-token' })),
}));
vi.mock('googleapis', () => ({ google: {
  auth: { GoogleAuth: class {
    async getClient() { return { getAccessToken: gmail.token }; }
  } },
  gmail: () => ({ users: { messages: { send: gmail.send } } }),
} }));

let sendMail: typeof import('./mailer.js').sendMail;
beforeAll(async () => {
  vi.stubEnv('GOOGLE_SA_KEY_PATH', 'mock-service-account.json');
  vi.stubEnv('GOOGLE_MAIL_FROM', 'notifications@example.com');
  ({ sendMail } = await import('./mailer.js'));
});
afterAll(() => vi.unstubAllEnvs());

describe('Gmail message composition with the patched Nodemailer', () => {
  it('preserves recipients, HTML and PDF bytes in the Gmail API message', async () => {
    const attachment = Buffer.from('signed pdf payload');
    await sendMail({
      to: 'customer@example.com', cc: 'billing@example.com',
      replyTo: 'office@example.com', subject: 'Inspection report',
      html: '<p>Inspection complete</p>',
      attachments: [{ filename: 'inspection.pdf', content: attachment, contentType: 'application/pdf' }],
    });
    const request = gmail.send.mock.calls.at(-1)![0] as any;
    expect(request.userId).toBe('me');
    expect(request.requestBody.raw).toMatch(/^[A-Za-z0-9_-]+$/);
    const mime = Buffer.from(request.requestBody.raw, 'base64url').toString('utf8');
    expect(mime).toContain('To: customer@example.com');
    expect(mime).toContain('Cc: billing@example.com');
    expect(mime).toContain('Reply-To: office@example.com');
    expect(mime).toContain('Subject: Inspection report');
    expect(mime).toContain('<p>Inspection complete</p>');
    expect(mime).toContain('application/pdf');
    expect(mime).toContain('inspection.pdf');
    expect(mime).toContain(attachment.toString('base64'));
  });
});
