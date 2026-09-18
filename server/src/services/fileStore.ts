/**
 * File storage abstraction.
 *
 *   STORAGE_DRIVER=local (default) — LocalFileStore, disk under STORAGE_DIR.
 *   STORAGE_DRIVER=s3              — S3FileStore, any S3-compatible endpoint
 *                                    (AWS, Backblaze B2, MinIO — see below).
 *
 * Paths are relative keys like "tickets/{id}/ticket-BSN-001.pdf"; the store
 * resolves them to a disk path or an object key internally.
 *
 * NB the interface has no `absolutePath`. It used to, and two routes used it to
 * `res.sendFile` straight off disk — which no object store can honour. Reading
 * happens through `read()` or `createReadStream()` so a driver swap can't
 * silently break a download path.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { existsSync, mkdirSync, createReadStream as fsCreateReadStream } from 'fs';
import { readFile, writeFile, unlink, stat, mkdir } from 'fs/promises';
import { join, dirname, resolve, sep } from 'path';
import type { Readable } from 'stream';

// ── Interface ──────────────────────────────────────────────

export interface FileStore {
  /** Write a file. Returns the relative storage key. */
  write(key: string, data: Buffer, mimeType?: string): Promise<string>;

  /** Read a file into memory. */
  read(key: string): Promise<Buffer>;

  /** Open a stream for piping to an HTTP response — avoids buffering big PDFs. */
  createReadStream(key: string): Promise<Readable>;

  /** Check if a file exists. */
  exists(key: string): Promise<boolean>;

  /** Delete a file (no-op if missing). */
  remove(key: string): Promise<void>;

  /** Get file size in bytes. */
  size(key: string): Promise<number>;
}

// ── Storage key helpers ────────────────────────────────────

/** Build a storage key for a ticket attachment. */
export function ticketKey(ticketId: string, fileName: string): string {
  return `tickets/${ticketId}/${fileName}`;
}

/** Build a storage key for an invoice attachment. */
export function invoiceKey(invoiceId: string, fileName: string): string {
  return `invoices/${invoiceId}/${fileName}`;
}

/** Build a storage key for an inspection attachment (condemn evidence / UE report). */
export function inspectionKey(inspectionId: string, fileName: string): string {
  return `equipment-inspections/${inspectionId}/${fileName}`;
}

/**
 * Build a storage key for a document that belongs to a UNIT rather than to the
 * inspection that produced it — UE reports and condemnation certs. Keyed by
 * equipment so a cylinder's regulatory history is one prefix for the life of
 * the bottle, however many inspections and packs it passes through.
 */
export function equipmentDocumentKey(equipmentId: string, revision: number, fileName: string): string {
  return `equipment-documents/${equipmentId}/r${revision}/${fileName}`;
}

// ── Local disk implementation ──────────────────────────────

export class LocalFileStore implements FileStore {
  private readonly root: string;

  constructor(rootDir?: string) {
    this.root = rootDir || process.env.STORAGE_DIR || join(process.cwd(), 'data', 'storage');
    // Ensure root exists on startup
    if (!existsSync(this.root)) {
      mkdirSync(this.root, { recursive: true });
    }
  }

  async write(key: string, data: Buffer, _mimeType?: string): Promise<string> {
    const absPath = this.absolutePath(key);
    const dir = dirname(absPath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(absPath, data);
    return key;
  }

  async read(key: string): Promise<Buffer> {
    return readFile(this.absolutePath(key));
  }

  async createReadStream(key: string): Promise<Readable> {
    return fsCreateReadStream(this.absolutePath(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.absolutePath(key));
      return true;
    } catch {
      return false;
    }
  }

  async remove(key: string): Promise<void> {
    try {
      await unlink(this.absolutePath(key));
    } catch {
      // Ignore if file doesn't exist
    }
  }

  absolutePath(key: string): string {
    // Resolve and confirm the key stays inside the storage root. Callers are
    // expected to sanitize keys, but this is the last line of defense against
    // a "../" that slips through and turns into a read/write outside STORAGE_DIR.
    const rootResolved = resolve(this.root);
    const abs = resolve(rootResolved, key);
    if (abs !== rootResolved && !abs.startsWith(rootResolved + sep)) {
      throw new Error('Resolved file path escapes storage root');
    }
    return abs;
  }

  async size(key: string): Promise<number> {
    const s = await stat(this.absolutePath(key));
    return s.size;
  }
}

// ── S3-compatible implementation ───────────────────────────

/**
 * Works against AWS S3, Backblaze B2, MinIO, or anything else speaking the S3
 * API — set S3_ENDPOINT for the non-AWS ones (B2 also needs
 * S3_FORCE_PATH_STYLE=1).
 *
 * Deliberately NOT an archival tier. UE reports are small and rare (tens of GB
 * across the fleet's whole life), so Glacier-class storage would save a couple
 * of dollars a month in exchange for multi-hour restores — and a UE report is
 * wanted precisely when a customer disputes a bottle or an incident review
 * starts. Durability comes from bucket versioning + object lock, not from tier.
 */
export class S3FileStore implements FileStore {
  private readonly bucket: string;
  private readonly client: S3Client;

  constructor(opts?: { bucket?: string; region?: string; endpoint?: string }) {
    const bucket = opts?.bucket || process.env.S3_BUCKET;
    if (!bucket) throw new Error('S3FileStore requires S3_BUCKET');
    this.bucket = bucket;

    const endpoint = opts?.endpoint || process.env.S3_ENDPOINT;
    const accessKeyId = process.env.S3_ACCESS_KEY_ID;
    const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;

    this.client = new S3Client({
      region: opts?.region || process.env.S3_REGION || 'us-east-1',
      ...(endpoint ? { endpoint, forcePathStyle: process.env.S3_FORCE_PATH_STYLE === '1' } : {}),
      // Omitting credentials lets the SDK fall back to the instance/role chain,
      // which is what you want if this ever runs somewhere with an IAM role.
      ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
    });
  }

  async write(key: string, data: Buffer, mimeType?: string): Promise<string> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: data,
      ...(mimeType ? { ContentType: mimeType } : {}),
    }));
    return key;
  }

  async read(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`S3 object has no body: ${key}`);
    return Buffer.from(await res.Body.transformToByteArray());
  }

  async createReadStream(key: string): Promise<Readable> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`S3 object has no body: ${key}`);
    return res.Body as Readable;
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async remove(key: string): Promise<void> {
    // With versioning on this writes a delete marker rather than destroying the
    // object — intentional for regulatory documents.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })).catch(() => {});
  }

  async size(key: string): Promise<number> {
    const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
    return head.ContentLength ?? 0;
  }
}

// ── Singleton ──────────────────────────────────────────────

let _store: FileStore | null = null;

export function getFileStore(): FileStore {
  if (!_store) {
    if ((process.env.STORAGE_DRIVER || 'local').toLowerCase() === 's3') {
      _store = new S3FileStore();
      console.log(`[fileStore] S3 driver — bucket ${process.env.S3_BUCKET}${process.env.S3_ENDPOINT ? ` @ ${process.env.S3_ENDPOINT}` : ''}`);
    } else {
      _store = new LocalFileStore();
    }
  }
  return _store;
}
