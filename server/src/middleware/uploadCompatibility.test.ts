import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import multer from 'multer';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

let server: Server;
let endpoint: string;
beforeAll(async () => {
  const app = express();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 } });
  app.post('/upload', upload.single('file'), (req, res) => {
    res.json({ name: req.file?.originalname, mime: req.file?.mimetype,
      bytes: req.file?.buffer.toString('base64'), owner: req.body.owner });
  });
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ code: err instanceof multer.MulterError ? err.code : 'INVALID_MULTIPART' });
  });
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/upload`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
});

describe('Multer memory upload compatibility', () => {
  it('retains binary bytes, filename, content type and accompanying fields', async () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    const body = new FormData();
    body.set('owner', 'ticket-123');
    body.set('file', new Blob([bytes], { type: 'application/pdf' }), 'report.pdf');
    const response = await fetch(endpoint, { method: 'POST', body });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: 'report.pdf', mime: 'application/pdf',
      bytes: Buffer.from(bytes).toString('base64'), owner: 'ticket-123' });
  });
  it('still enforces the configured byte limit', async () => {
    const body = new FormData();
    body.set('file', new Blob([new Uint8Array(65)]), 'too-large.pdf');
    const response = await fetch(endpoint, { method: 'POST', body });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: 'LIMIT_FILE_SIZE' });
  });
  it('rejects truncated multipart data and remains able to process requests', async () => {
    const response = await fetch(endpoint, { method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=unfinished' },
      body: '--unfinished\r\nContent-Disposition: form-data; name="file"; filename="bad.pdf"\r\n\r\nbroken',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: 'INVALID_MULTIPART' });
    const healthy = await fetch(endpoint, { method: 'POST', body: new FormData() });
    expect(healthy.status).toBe(200);
  });
});
