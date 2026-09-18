import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// These tests are legitimately slow, and the 5-second default is too tight for
// them on a cold CI runner.
//
// Every `loadStore()` below calls vi.resetModules() and re-imports the store's
// whole module graph — which reaches fileStore.ts, which imports
// @aws-sdk/client-s3 at the top level. That is a big graph to re-resolve and
// re-transform, eighteen times in this file, and whichever test happens to run
// first pays the cold-cache cost for all of them (~6s observed on the build
// host, comfortably under 1s locally with a warm cache).
//
// The re-import is not incidental — it is how these tests get a fresh
// STORAGE_DRIVER read and fresh temp directories per case, which is the whole
// point of a suite about where bytes physically live. So the fix is room, not
// speed. Do not lower this back to the default: the test that fails will not
// be failing because anything is broken.
vi.setConfig({ testTimeout: 30_000 });

// The store reads STORAGE_DRIVER / dir env at first use, so the environment has
// to be set before the module is imported. Each test gets its own throwaway
// directories so nothing leaks between them.
let bufferDir: string;
let storageDir: string;

async function loadStore(driver: 'local' | 's3') {
  vi.resetModules();
  bufferDir = mkdtempSync(join(tmpdir(), 'sundog-buf-'));
  storageDir = mkdtempSync(join(tmpdir(), 'sundog-store-'));
  process.env.ATTACHMENT_BUFFER_DIR = bufferDir;
  process.env.STORAGE_DIR = storageDir;
  process.env.STORAGE_DRIVER = driver;
  const mod = await import('./attachmentStore.js');
  // Stand-in for B2. A real filesystem, not a mock: these tests are about
  // whether bytes survive the trip, and a mock that hands back whatever it was
  // given would pass the checksum comparison for the wrong reason.
  const { LocalFileStore } = await import('./fileStore.js');
  const remote = new LocalFileStore(storageDir);
  return { ...mod, remote };
}

afterEach(() => {
  for (const d of [bufferDir, storageDir]) {
    if (d) rmSync(d, { recursive: true, force: true });
  }
  delete process.env.ATTACHMENT_BUFFER_DIR;
  delete process.env.STORAGE_DIR;
  delete process.env.STORAGE_DRIVER;
});

const PHOTO = Buffer.from('pretend this is a photo of a condemned cylinder');

describe('attachmentKey', () => {
  it('namespaces by parent and includes the attachment id', async () => {
    const { attachmentKey } = await loadStore('local');
    expect(attachmentKey({ shopItemId: 'item-1' }, 'att-1', 'photo.jpg'))
      .toBe('shop-items/item-1/att-1/photo.jpg');
    expect(attachmentKey({ inspectionId: 'insp-1' }, 'att-2', 'ue.pdf'))
      .toBe('inspections/insp-1/att-2/ue.pdf');
  });

  it('keeps two identically-named camera files apart', async () => {
    const { attachmentKey } = await loadStore('local');
    // Every phone calls it IMG_0001.jpg. Without the id in the path, unit 2's
    // photo would overwrite unit 1's and nobody would notice until an audit.
    const a = attachmentKey({ shopItemId: 'item-1' }, 'att-a', 'IMG_0001.jpg');
    const b = attachmentKey({ shopItemId: 'item-1' }, 'att-b', 'IMG_0001.jpg');
    expect(a).not.toBe(b);
  });

  it('defuses path traversal in a supplied file name', async () => {
    const { attachmentKey } = await loadStore('local');
    const key = attachmentKey({ ticketId: 't1' }, 'att-1', '../../../etc/passwd');
    expect(key).not.toContain('..');
    expect(key.startsWith('tickets/t1/att-1/')).toBe(true);
  });
});

describe('ingest — hop 1, taking custody', () => {
  it('with no remote tier, lands directly in the store as remote', async () => {
    // Dev and any single-box deploy: the configured store IS the destination,
    // so there is no second hop and nothing should sit in a buffer forever
    // waiting for an uploader that will never run.
    const { ingestAttachmentBytes } = await loadStore('local');
    const result = await ingestAttachmentBytes(PHOTO, 'shop-items/i/a/p.jpg', 'image/jpeg');
    expect(result.storageState).toBe('remote');
    expect(result.remoteKey).toBe('shop-items/i/a/p.jpg');
    expect(result.bufferKey).toBeNull();
    expect(result.uploadedAt).not.toBeNull();
  });

  it('with a remote tier, buffers on the SP server and does NOT claim remote', async () => {
    const { ingestAttachmentBytes } = await loadStore('s3');
    const result = await ingestAttachmentBytes(PHOTO, 'shop-items/i/a/p.jpg', 'image/jpeg');
    expect(result.storageState).toBe('buffered');
    expect(result.bufferKey).toBe('shop-items/i/a/p.jpg');
    expect(result.remoteKey).toBeNull();
    // Nothing may claim an upload time before an upload has happened.
    expect(result.uploadedAt).toBeNull();
  });

  it('records a checksum of the bytes', async () => {
    const { ingestAttachmentBytes, sha256Of } = await loadStore('s3');
    const result = await ingestAttachmentBytes(PHOTO, 'k', 'image/jpeg');
    expect(result.sha256).toBe(sha256Of(PHOTO));
    expect(result.fileSizeBytes).toBe(PHOTO.length);
  });

  it('rejects a transfer whose checksum disagrees with the device', async () => {
    // Rejecting here matters because the device still holds the original. Accept
    // it now and the corruption is only discoverable after the original is gone.
    const { ingestAttachmentBytes } = await loadStore('s3');
    await expect(
      ingestAttachmentBytes(PHOTO, 'k', 'image/jpeg', 'deadbeef'.repeat(8)),
    ).rejects.toThrow(/checksum mismatch/i);
  });

  it('accepts a matching device checksum', async () => {
    const { ingestAttachmentBytes, sha256Of } = await loadStore('s3');
    const result = await ingestAttachmentBytes(PHOTO, 'k', 'image/jpeg', sha256Of(PHOTO));
    expect(result.storageState).toBe('buffered');
  });
});

describe('promote — hop 2, and the buffer copy it protects', () => {
  it('verifies the read-back and only then drops the buffer copy', async () => {
    const { ingestAttachmentBytes, promoteToRemote, getBufferStore, remote } = await loadStore('s3');
    const key = 'shop-items/i/a/p.jpg';
    const ingested = await ingestAttachmentBytes(PHOTO, key, 'image/jpeg');
    expect(await getBufferStore().exists(key)).toBe(true);

    const promoted = await promoteToRemote({
      id: 'att-1', bufferKey: key, sha256: ingested.sha256,
      mimeType: 'image/jpeg', fileName: 'p.jpg',
    }, remote);

    expect(promoted.remoteKey).toBe(key);
    // Buffer copy released only after a verified remote read-back.
    expect(await getBufferStore().exists(key)).toBe(false);
  });

  it('refuses to upload a buffer copy that no longer matches its checksum', async () => {
    // Bad disk, or a partial write from an earlier crash. Uploading it unchecked
    // would launder a corrupt file into the durable store and then delete the
    // only evidence that it was corrupt.
    const { ingestAttachmentBytes, promoteToRemote, getBufferStore, remote } = await loadStore('s3');
    const key = 'k';
    await ingestAttachmentBytes(PHOTO, key, 'image/jpeg');

    await expect(
      promoteToRemote({
        id: 'att-1', bufferKey: key,
        sha256: 'f'.repeat(64), // not what is on disk
        mimeType: 'image/jpeg', fileName: 'p.jpg',
      }, remote),
    ).rejects.toThrow(/no longer matches its recorded checksum/i);

    // The whole point: the questionable copy is KEPT, not cleaned up.
    expect(await getBufferStore().exists(key)).toBe(true);
  });

  it('refuses an attachment with no buffer copy to promote', async () => {
    const { promoteToRemote, remote } = await loadStore('s3');
    await expect(
      promoteToRemote({ id: 'att-1', bufferKey: null, sha256: 'x', mimeType: null, fileName: 'p.jpg' }, remote),
    ).rejects.toThrow(/no buffer key/i);
  });
});

describe('read — bytes are served from whichever tier holds them', () => {
  it('serves a buffered attachment before it ever reaches the object store', async () => {
    // A tech who just took a photo sees it immediately; nothing waits on B2.
    const { ingestAttachmentBytes, readAttachmentBytes } = await loadStore('s3');
    await ingestAttachmentBytes(PHOTO, 'k', 'image/jpeg');
    const bytes = await readAttachmentBytes({
      storageState: 'buffered', bufferKey: 'k', remoteKey: null,
    });
    expect(bytes.equals(PHOTO)).toBe(true);
  });

  it('serves a promoted attachment from the object store', async () => {
    const { ingestAttachmentBytes, promoteToRemote, readAttachmentBytes, remote } = await loadStore('s3');
    const ingested = await ingestAttachmentBytes(PHOTO, 'k', 'image/jpeg');
    await promoteToRemote({
      id: 'a', bufferKey: 'k', sha256: ingested.sha256, mimeType: 'image/jpeg', fileName: 'p.jpg',
    }, remote);
    const bytes = await readAttachmentBytes({
      storageState: 'remote', bufferKey: null, remoteKey: 'k',
    }, remote);
    expect(bytes.equals(PHOTO)).toBe(true);
  });

  it('still serves a failed attachment from its retained buffer copy', async () => {
    // 'failed' means "surfacing this to a human", not "the file is gone".
    const { ingestAttachmentBytes, readAttachmentBytes } = await loadStore('s3');
    await ingestAttachmentBytes(PHOTO, 'k', 'image/jpeg');
    const bytes = await readAttachmentBytes({
      storageState: 'failed', bufferKey: 'k', remoteKey: null,
    });
    expect(bytes.equals(PHOTO)).toBe(true);
  });

  it('throws rather than returning empty when no copy is recorded', async () => {
    const { readAttachmentBytes } = await loadStore('s3');
    await expect(
      readAttachmentBytes({ storageState: 'buffered', bufferKey: null, remoteKey: null }),
    ).rejects.toThrow(/no readable copy/i);
  });
});

describe('remoteTierEnabled', () => {
  it('is true only for the s3 driver', async () => {
    expect((await loadStore('s3')).remoteTierEnabled()).toBe(true);
    expect((await loadStore('local')).remoteTierEnabled()).toBe(false);
  });
});
