/**
 * QBWC SOAP Handler
 *
 * QuickBooks Web Connector polls this endpoint. It speaks SOAP —
 * we parse the raw XML ourselves (the protocol is simple and fixed).
 *
 * Flow per session:
 *   1. QBWC calls authenticate(user, pass) → we return a ticket + status
 *   2. QBWC calls sendRequestXML(ticket) → we return next qbXML request from queue
 *   3. QBWC sends that to QB, gets response, calls receiveResponseXML(ticket, response)
 *   4. We parse the response, update the queue entry, return progress %
 *   5. Repeat 2-4 until we return 100% or empty string
 *   6. QBWC calls closeConnection(ticket)
 */

import { Router, Request, Response } from 'express';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
// prisma from db.js, not index.js: index.ts registers this router, so importing
// it back from here is a cycle — which breaks any one-off script that imports
// this module (e.g. scripts/preview-qb-invoice.ts) mid-initialization.
import { prisma } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import {
  buildSalesOrderAdd, parseSalesOrderResponse,
  buildInvoiceAdd, parseInvoiceAddResponse,
  buildSalesOrderQueryForLinkedInvoice, buildInvoiceQueryByRefNumber, parseInvoiceQueryResponse,
  buildInvoiceQueryByTxnId, parseInvoiceDiffResponse,
  buildSalesReceiptAdd, parseSalesReceiptResponse,
  buildItemQueryRq, parseItemQueryResponse,
  buildPriceLevelQueryRq, parsePriceLevelQueryResponse,
  buildSalesTaxQueryRq, parseSalesTaxQueryResponse,
  type QbSalesOrderData, type QbSalesOrderLine, type QbSalesReceiptData,
} from '../services/qbxmlBuilder.js';
import {
  resolveQbClassFullName, defaultDivisionForWork,
  DICKINSON_SITE_SHORT_CODE, SHOP_DIVISION,
} from '../utils/qbClass.js';
import { qbLocationLabel, truncateQbOther } from '../utils/qbLocation.js';
import { RENTAL_DEFAULT_DIVISION } from '../services/rentalComposition.js';
import type { ServiceDivision } from '../db.js';
import { parsePartNumber, partNumberFacetColumns } from '../utils/partNumber.js';
import {
  qbItemLeafName, productCreateFromQbItem, PRODUCT_TYPE_FOR_QB_ITEM_TYPE,
} from '../services/qbItemMapping.js';
import { decodeHtmlEntities } from '../utils/htmlEntities.js';
import { recordDocRefObservationByDocNumber } from '../services/billingObservations.js';
import { upsertDocRefAndLines } from '../services/billingLineage.js';

export const qbwcRouter = Router();

// Guard for the diagnostic + queue-management endpoints below. QBWC itself only
// hits /soap (and the /qwc + /cert setup downloads), which stay public because
// the Web Connector carries its own username/password. Everything else exposes
// queued invoices (customer PII + dollar amounts) or mutates the sync queue, so
// it requires a logged-in staff user with the QB-sync capability.
const qbAdminGuard = [authenticate, requirePermission('billing:qb_sync')];

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const QBWC_USERNAME = process.env.QBWC_USERNAME || 'sundog';
const QBWC_PASSWORD = process.env.QBWC_PASSWORD || '';
const QBWC_FILE_ID = process.env.QBWC_FILE_ID || '{57F3B9B6-86A0-4847-B8C7-4285E4B3B556}';
const QBWC_OWNER_ID = process.env.QBWC_OWNER_ID || '{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}';

// Name QBWC lists this registration under. The Web Connector keys its app list
// on AppName + FileID, so a sandbox sharing the QB host has to differ in both
// or it overwrites prod's registration instead of sitting alongside it.
const QBWC_APP_NAME = process.env.QBWC_APP_NAME || 'Service Pro - Basin Safety';

// Absolute path to the .QBW this instance may talk to, as seen by the QBWC
// host. Normally empty, and empty is not "any file": QBWC records which company
// file each registration was authorised against and reuses it, so two
// registrations on one host already reach two different company files.
//
// Setting this adds server-side enforcement on top of that binding — we name
// the file on every authenticate, and QuickBooks refuses the session if a
// different one is open. Worth it for a sandbox sharing a host with production,
// where the failure mode of a registration authorised against the wrong file is
// test invoices in the real ledger.
const QBWC_COMPANY_FILE = process.env.QBWC_COMPANY_FILE || '';

// Auto-run interval baked into the .qwc, in minutes. 0 registers the app with
// no <Scheduler> block at all, so it only ever runs when someone clicks Update
// Selected in the Web Connector.
//
// That is the setting that lets two registrations share a QB host. QuickBooks
// opens one company file at a time, so two scheduled apps bound to different
// files would fight; two manual ones simply run when their file is the one
// open. Worth remembering that auto-run was never truly unattended anyway — the
// Web Connector is a desktop app, so it already needed a signed-in user with QB
// up, a file open and no modal dialogs.
const QBWC_RUN_EVERY_N_MINUTES = Math.max(
  0,
  parseInt(process.env.QBWC_RUN_EVERY_N_MINUTES || '5', 10) || 0,
);

// Kill switch for the Web Connector poll loop. When QuickBooks itself can't be
// started on the QBWC host (hresult 0x80040408), every poll opens a session,
// fails to launch QB, and logs a connectionError — a few hundred lines a day of
// noise SP can do nothing about. Setting QBWC_ENABLED=false makes authenticate
// always answer "none", so QBWC never tries to open QB.
// NOTE: the sync queue keeps filling while this is off — nothing is dropped,
// but nothing reaches QB either. Flip it back on once QB is launchable again.
const QBWC_ENABLED = !['false', '0', 'off', 'no'].includes(
  (process.env.QBWC_ENABLED || 'true').trim().toLowerCase()
);
const SERVER_VERSION = '1.0.0';
const MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// Session management (in-memory — single server is fine for QBWC)
// ---------------------------------------------------------------------------

interface QbwcSession {
  ticket: string;
  createdAt: Date;
  currentQueueId: string | null;   // which queue entry we're currently processing
  totalItems: number;              // total pending at session start
  processedItems: number;
  lastError: string | null;
}

const sessions = new Map<string, QbwcSession>();

// Track last item sync time — auto-queue every hour
let lastItemSyncQueuedAt = 0;
const ITEM_SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// Track last sales-tax sync time — auto-queue daily (tax tables change rarely)
let lastSalesTaxSyncQueuedAt = 0;
const SALES_TAX_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Clean stale sessions older than 30 min
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [ticket, sess] of sessions) {
    if (sess.createdAt.getTime() < cutoff) sessions.delete(ticket);
  }
}, 5 * 60 * 1000);

// ---------------------------------------------------------------------------
// SOAP XML helpers
// ---------------------------------------------------------------------------

const TNS = 'http://developer.intuit.com/';

function soapEnvelope(bodyXml: string): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="http://developer.intuit.com/">',
    '  <soap:Body>',
    bodyXml,
    '  </soap:Body>',
    '</soap:Envelope>',
  ].join('\n');
}

/**
 * Extract the value of a simple text element from SOAP XML.
 * e.g. extractElement(xml, 'strUserName') → 'sundog'
 */
function extractElement(xml: string, name: string): string {
  // Handle both namespaced and non-namespaced
  const patterns = [
    new RegExp(`<(?:[^:]+:)?${name}[^>]*>([\\s\\S]*?)</(?:[^:]+:)?${name}>`, 'i'),
    new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'),
  ];
  for (const re of patterns) {
    const m = xml.match(re);
    if (m) return m[1].trim();
  }
  return '';
}

/**
 * Detect which SOAP method is being called from the SOAPAction header or body.
 */
function detectMethod(soapAction: string, body: string): string {
  // SOAPAction header is most reliable: "http://developer.intuit.com/authenticate"
  if (soapAction) {
    const parts = soapAction.replace(/"/g, '').split('/');
    return parts[parts.length - 1];
  }
  // Fall back to body inspection
  const methods = ['authenticate', 'sendRequestXML', 'receiveResponseXML',
    'closeConnection', 'connectionError', 'getLastError', 'serverVersion', 'clientVersion'];
  for (const m of methods) {
    if (body.includes(`<${m}`) || body.includes(`:${m}`)) return m;
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// SOAP Method Handlers
// ---------------------------------------------------------------------------

function handleServerVersion(): string {
  return soapEnvelope(`
    <tns:serverVersionResponse>
      <tns:serverVersionResult>${SERVER_VERSION}</tns:serverVersionResult>
    </tns:serverVersionResponse>`);
}

function handleClientVersion(xml: string): string {
  // We accept any client version
  return soapEnvelope(`
    <tns:clientVersionResponse>
      <tns:clientVersionResult></tns:clientVersionResult>
    </tns:clientVersionResponse>`);
}

async function handleAuthenticate(xml: string): Promise<string> {
  const username = extractElement(xml, 'strUserName');
  const password = extractElement(xml, 'strPassword');

  // Never authenticate against an empty/unset credential — a blank QBWC_PASSWORD
  // would otherwise let any client presenting the default username straight in.
  if (!QBWC_PASSWORD || username !== QBWC_USERNAME || password !== QBWC_PASSWORD) {
    console.log(`[QBWC] auth FAILED: username match=${username === QBWC_USERNAME}, password match=${password === QBWC_PASSWORD}`);
    return soapEnvelope(`
    <tns:authenticateResponse>
      <tns:authenticateResult>
        <tns:string></tns:string>
        <tns:string>nvu</tns:string>
      </tns:authenticateResult>
    </tns:authenticateResponse>`);
  }

  if (!QBWC_ENABLED) {
    logDisabledPoll();
    return soapEnvelope(`
    <tns:authenticateResponse>
      <tns:authenticateResult>
        <tns:string>${uuidv4()}</tns:string>
        <tns:string>none</tns:string>
      </tns:authenticateResult>
    </tns:authenticateResponse>`);
  }

  // ── Recover stuck 'sent' entries ──
  // If a previous QBWC session died mid-flight (server restart, network drop, timeout),
  // entries can get stuck in 'sent' status forever. Reset them back to 'pending'.
  const STUCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  const stuckCutoff = new Date(Date.now() - STUCK_TIMEOUT_MS);

  const stuckRecovered = await prisma.qbSyncQueue.updateMany({
    where: {
      status: 'sent',
      sentAt: { lt: stuckCutoff },
    },
    data: {
      status: 'pending',
      sentAt: null,
    },
  });

  if (stuckRecovered.count > 0) {
    console.log(`[QBWC] Recovered ${stuckRecovered.count} stuck 'sent' entries → pending`);
  }

  // ── Re-queue invoice queries for SO→Invoice detection ──
  // Invoices stuck in 'so_created' that don't already have a pending query
  // get a new query queued each QBWC cycle (up to MAX_INVOICE_QUERY_ATTEMPTS).
  const soCreatedInvoices = await prisma.invoice.findMany({
    where: { status: 'so_created', qbSalesOrderTxnId: { not: null } },
    select: { id: true, invoiceNumber: true },
  });

  for (const inv of soCreatedInvoices) {
    // queueInvoiceQuery already guards against duplicates + max attempts
    await queueInvoiceQuery(inv.id);
  }

  // ── Auto-queue item sync if overdue ──
  const now = Date.now();
  if (now - lastItemSyncQueuedAt > ITEM_SYNC_INTERVAL_MS) {
    // Check there isn't already a pending item query
    const existingItemQuery = await prisma.qbSyncQueue.findFirst({
      where: { entityType: 'item', action: 'query', status: { in: ['pending', 'sent'] } },
    });
    if (!existingItemQuery) {
      await prisma.qbSyncQueue.create({
        data: {
          entityType: 'item',
          action: 'query',
          entityId: 'all-items',
          priority: 15,  // low priority — after SOs (5) and invoice queries (10)
          status: 'pending',
        },
      });
      lastItemSyncQueuedAt = now;
      console.log('[QBWC] Auto-queued item sync');
    }
  }

  // ── Auto-queue sales-tax sync if overdue ──
  if (now - lastSalesTaxSyncQueuedAt > SALES_TAX_SYNC_INTERVAL_MS) {
    const existingTaxQuery = await prisma.qbSyncQueue.findFirst({
      where: { entityType: 'sales_tax', action: 'query', status: { in: ['pending', 'sent'] } },
    });
    if (!existingTaxQuery) {
      await prisma.qbSyncQueue.create({
        data: {
          entityType: 'sales_tax',
          action: 'query',
          entityId: 'all-sales-tax',
          priority: 15,  // low priority — alongside item sync
          status: 'pending',
        },
      });
      lastSalesTaxSyncQueuedAt = now;
      console.log('[QBWC] Auto-queued sales-tax sync');
    }
  }

  // Check if there's anything in the queue
  const pendingCount = await prisma.qbSyncQueue.count({
    where: { status: 'pending', retryCount: { lt: MAX_RETRIES } },
  });

  const ticket = uuidv4();
  sessions.set(ticket, {
    ticket,
    createdAt: new Date(),
    currentQueueId: null,
    totalItems: pendingCount,
    processedItems: 0,
    lastError: null,
  });

  if (pendingCount === 0) {
    return soapEnvelope(`
    <tns:authenticateResponse>
      <tns:authenticateResult>
        <tns:string>${ticket}</tns:string>
        <tns:string>none</tns:string>
      </tns:authenticateResult>
    </tns:authenticateResponse>`);
  }

  const fileNote = QBWC_COMPANY_FILE ? ` file=${QBWC_COMPANY_FILE}` : ' file=<currently open>';
  console.log(`[QBWC] auth OK, ${pendingCount} items pending, ticket=${ticket},${fileNote}`);
  // Second element of the result is the company file to work against: empty
  // means "whatever is open in QB", a path pins the session to that one file.
  return soapEnvelope(`
    <tns:authenticateResponse>
      <tns:authenticateResult>
        <tns:string>${ticket}</tns:string>
        <tns:string>${escapeXmlForSoap(QBWC_COMPANY_FILE)}</tns:string>
      </tns:authenticateResult>
    </tns:authenticateResponse>`);
}

async function handleSendRequestXML(xml: string): Promise<string> {
  const ticket = extractElement(xml, 'ticket');
  const session = sessions.get(ticket);
  if (!session) {
    console.log('[QBWC] sendRequestXML: invalid ticket');
    return soapEnvelope(`
    <tns:sendRequestXMLResponse>
      <tns:sendRequestXMLResult></tns:sendRequestXMLResult>
    </tns:sendRequestXMLResponse>`);
  }

  // Get next pending queue entry
  const entry = await prisma.qbSyncQueue.findFirst({
    where: { status: 'pending', retryCount: { lt: MAX_RETRIES } },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
  });

  if (!entry) {
    console.log('[QBWC] sendRequestXML: queue empty');
    // Return empty = nothing to do, QBWC will call getLastError then closeConnection
    return soapEnvelope(`
    <tns:sendRequestXMLResponse>
      <tns:sendRequestXMLResult></tns:sendRequestXMLResult>
    </tns:sendRequestXMLResponse>`);
  }

  console.log(`[QBWC] sendRequestXML: processing queue ${entry.id} (${entry.entityType}/${entry.action})`);

  // Build the qbXML request based on entity type + action
  let qbxmlRequest: string;
  try {
    qbxmlRequest = await buildQbxmlForEntry(entry);
  } catch (err: any) {
    console.error(`[QBWC] Error building qbXML for ${entry.id}:`, err.message);
    // Do not revive a job cancelled while XML was being built.
    await prisma.qbSyncQueue.updateMany({
      where: { id: entry.id, status: 'pending' },
      data: {
        status: 'error',
        errorMessage: `Build error: ${err.message}`,
        completedAt: new Date(),
      },
    });
    session.processedItems++;
    // Return empty to get next item
    return soapEnvelope(`
    <tns:sendRequestXMLResponse>
      <tns:sendRequestXMLResult></tns:sendRequestXMLResult>
    </tns:sendRequestXMLResponse>`);
  }

  // Claim only if still pending: a billing waiver may cancel during XML construction.
  const claimed = await prisma.qbSyncQueue.updateMany({
    where: { id: entry.id, status: 'pending' },
    data: {
      status: 'sent',
      qbxmlRequest,
      sentAt: new Date(),
    },
  });

  if (claimed.count === 0) return soapEnvelope(`<tns:sendRequestXMLResponse><tns:sendRequestXMLResult></tns:sendRequestXMLResult></tns:sendRequestXMLResponse>`);
  session.currentQueueId = entry.id;

  return soapEnvelope(`
    <tns:sendRequestXMLResponse>
      <tns:sendRequestXMLResult>${escapeXmlForSoap(qbxmlRequest)}</tns:sendRequestXMLResult>
    </tns:sendRequestXMLResponse>`);
}

async function handleReceiveResponseXML(xml: string): Promise<string> {
  const ticket = extractElement(xml, 'ticket');
  const response = extractElement(xml, 'response');
  const hresult = extractElement(xml, 'hresult');
  const message = extractElement(xml, 'message');

  const session = sessions.get(ticket);
  if (!session) {
    return soapEnvelope(`
    <tns:receiveResponseXMLResponse>
      <tns:receiveResponseXMLResult>-1</tns:receiveResponseXMLResult>
    </tns:receiveResponseXMLResponse>`);
  }

  const queueId = session.currentQueueId;
  if (!queueId) {
    console.log('[QBWC] receiveResponseXML: no current queue item');
    return soapEnvelope(`
    <tns:receiveResponseXMLResponse>
      <tns:receiveResponseXMLResult>100</tns:receiveResponseXMLResult>
    </tns:receiveResponseXMLResponse>`);
  }

  // Unescape the response (QBWC sends it HTML-encoded inside the SOAP body)
  const decodedResponse = unescapeXml(response);

  if (hresult) {
    console.warn(`[QBWC] receiveResponseXML hresult=${hresult}: ${message}`);
  }

  // Load the queue entry
  const entry = await prisma.qbSyncQueue.findUnique({ where: { id: queueId } });
  if (!entry) {
    session.processedItems++;
    session.currentQueueId = null;
    return progressResponse(session);
  }

  // Parse the qbXML response
  try {
    await processQbResponse(entry, decodedResponse, hresult, message);
  } catch (err: any) {
    console.error(`[QBWC] Error processing response for ${queueId}:`, err.message);
    await prisma.qbSyncQueue.update({
      where: { id: queueId },
      data: {
        status: 'error',
        errorMessage: err.message,
        qbxmlResponse: decodedResponse || null,
        completedAt: new Date(),
      },
    });
  }

  session.processedItems++;
  session.currentQueueId = null;

  return progressResponse(session);
}

function handleGetLastError(xml: string): string {
  const ticket = extractElement(xml, 'ticket');
  const session = sessions.get(ticket);
  const err = session?.lastError || '';

  return soapEnvelope(`
    <tns:getLastErrorResponse>
      <tns:getLastErrorResult>${escapeXmlForSoap(err)}</tns:getLastErrorResult>
    </tns:getLastErrorResponse>`);
}

function handleCloseConnection(xml: string): string {
  const ticket = extractElement(xml, 'ticket');
  const session = sessions.get(ticket);
  const processed = session?.processedItems || 0;

  console.log(`[QBWC] closeConnection: processed ${processed} items`);
  sessions.delete(ticket);

  return soapEnvelope(`
    <tns:closeConnectionResponse>
      <tns:closeConnectionResult>OK, processed ${processed} items</tns:closeConnectionResult>
    </tns:closeConnectionResponse>`);
}

// Repeated identical connection errors are one fact, not N facts — the Web
// Connector re-polls on its own schedule and each failed poll reports the same
// hresult. Log the first, then a rolled-up count at most once every 15 minutes.
const LOG_ROLLUP_MS = 15 * 60 * 1000;

let lastConnErrorKey = '';
let lastConnErrorLoggedAt = 0;
let suppressedConnErrors = 0;

let lastDisabledLogAt = 0;

function logDisabledPoll(): void {
  const now = Date.now();
  if (now - lastDisabledLogAt < LOG_ROLLUP_MS) return;
  lastDisabledLogAt = now;
  console.log('[QBWC] disabled (QBWC_ENABLED=false) — answering "none"; queue is still accumulating');
}

function handleConnectionError(xml: string): string {
  const ticket = extractElement(xml, 'ticket');
  const hresult = extractElement(xml, 'hresult');
  const message = extractElement(xml, 'message');

  const key = `${hresult}|${message}`;
  const now = Date.now();
  if (key !== lastConnErrorKey || now - lastConnErrorLoggedAt >= LOG_ROLLUP_MS) {
    const repeats = key === lastConnErrorKey && suppressedConnErrors > 0
      ? ` (${suppressedConnErrors} identical since last log)`
      : '';
    console.error(`[QBWC] connectionError: hresult=${hresult}, message=${message}${repeats}`);
    lastConnErrorKey = key;
    lastConnErrorLoggedAt = now;
    suppressedConnErrors = 0;
  } else {
    suppressedConnErrors++;
  }

  sessions.delete(ticket);

  return soapEnvelope(`
    <tns:connectionErrorResponse>
      <tns:connectionErrorResult>done</tns:connectionErrorResult>
    </tns:connectionErrorResponse>`);
}

// ---------------------------------------------------------------------------
// Queue Processing Logic
// ---------------------------------------------------------------------------

/**
 * Build qbXML request for a queue entry.
 * Supports: invoice/add, sales_order/add, invoice/query
 */
async function buildQbxmlForEntry(entry: { id: string; entityType: string; action: string; entityId: string }): Promise<string> {
  if (entry.entityType === 'invoice' && entry.action === 'add') {
    return buildInvoiceAddFromInvoice(entry.entityId);
  }

  if (entry.entityType === 'sales_order' && entry.action === 'add') {
    return buildSalesOrderFromInvoice(entry.entityId);
  }

  if (entry.entityType === 'invoice' && entry.action === 'query') {
    return buildInvoiceQueryFromInvoice(entry.entityId);
  }

  if (entry.entityType === 'sales_receipt' && entry.action === 'add') {
    return buildSalesReceiptFromPayment(entry.entityId);
  }

  if (entry.entityType === 'item' && entry.action === 'query') {
    // For delta syncs, we could pass a fromModifiedDate.
    // For now, pull all items (first sync / full refresh).
    // Future: store last sync date and pass it here.
    return buildItemQueryRq();
  }

  if (entry.entityType === 'price_level' && entry.action === 'query') {
    // Wave 5 5B: pull QB Per-Item price levels. First sync = full pull;
    // delta sync (passing fromModifiedDate) is a future tightening.
    return buildPriceLevelQueryRq();
  }

  if (entry.entityType === 'sales_tax' && entry.action === 'query') {
    // Pull QB's Sales Tax Items + Groups so qbTaxItemName can be reconciled
    // against real QB names (fixes recurring 3140 invalid-tax-ref rejects).
    return buildSalesTaxQueryRq();
  }

  throw new Error(`Unsupported queue entry: ${entry.entityType}/${entry.action}`);
}

/**
 * Build a qbXML request to check if a Sales Order has been converted
 * to an Invoice in QB Desktop.
 *
 * Strategy: Query the Sales Order itself with IncludeLinkedTxn=true.
 * If the comptroller has converted SO→Invoice, the response will contain
 * a LinkedTxn block with TxnType=Invoice. This is the only reliable way
 * to detect the conversion — InvoiceQueryRq does NOT support LinkToTxnID.
 *
 * Fallback: If we don't have the SO TxnID, search invoices by RefNumber.
 */
async function buildInvoiceQueryFromInvoice(invoiceId: string): Promise<string> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: {
      invoiceNumber: true,
      qbSalesOrderTxnId: true,
      qbSalesOrderNumber: true,
      qbInvoiceTxnId: true,
    },
  });

  if (!invoice) throw new Error(`Invoice ${invoiceId} not found`);

  // Slice F: if QB already has an Invoice TxnID for this record, the diff
  // watcher is asking us to compare current state — query the Invoice
  // directly (with line items) instead of going through the SO conversion
  // dance.
  if (invoice.qbInvoiceTxnId) {
    return buildInvoiceQueryByTxnId(invoice.qbInvoiceTxnId);
  }

  if (!invoice.qbSalesOrderTxnId && !invoice.qbSalesOrderNumber) {
    throw new Error(`Invoice ${invoice.invoiceNumber}: no Sales Order in QB yet`);
  }

  // Query the Sales Order and check its LinkedTxn for Invoice conversion
  if (invoice.qbSalesOrderTxnId) {
    return buildSalesOrderQueryForLinkedInvoice(invoice.qbSalesOrderTxnId);
  }

  // Fallback: search invoices by RefNumber (less reliable)
  return buildInvoiceQueryByRefNumber(invoice.invoiceNumber);
}

/**
 * Resolve the QB header CLASS + LOCATION for an invoice.
 *
 * Both used to come out blank in QB:
 *   - CLASS needs Invoice.division, which is null on every invoice whose source
 *     work never went through the field-service wizard step that asks for it
 *     (IH testing, occ health, training) and on shop-WO / rental invoices,
 *     which never copied a division at all.
 *   - LOCATION (the template's rename of qbXML <Other>) was simply never sent.
 *
 * Rather than only fixing it going forward, resolve both from the invoice's
 * source work at push time — that way the invoices already sitting in the
 * queue push with a class and a location too, without a data backfill.
 *
 * Precedence for the class: what's frozen on the invoice → what's on the
 * source ticket → the work-type default (shop is D6, rentals D4, IH is D3).
 */
async function resolveInvoiceClassAndLocation(invoice: {
  invoiceNumber: string;
  division: ServiceDivision | null;
  isDickinson: boolean;
  shopWorkOrderId: string | null;
  rentalAgreementId: string | null;
  lineItems: { sourceTicketId: string | null }[];
}): Promise<{ division: ServiceDivision | null; isDickinson: boolean; location: string | null }> {
  let division: ServiceDivision | null = invoice.division;
  let isDickinson = invoice.isDickinson;
  let location: string | null = null;

  const locationSelect = {
    ticketType: true, serviceSubtype: true, division: true, isDickinson: true,
    locationDisplay: true,
    well: { select: { wellName: true } },
    pad: { select: { name: true } },
    facility: { select: { name: true } },
    field: { select: { name: true } },
  } as const;

  // Source tickets, in line order — the first one with a location wins.
  const ticketIds = [...new Set(invoice.lineItems.map(li => li.sourceTicketId).filter((id): id is string => !!id))];
  if (ticketIds.length > 0) {
    const rows = await prisma.serviceTicket.findMany({
      where: { id: { in: ticketIds } },
      select: { id: true, ...locationSelect },
    });
    // findMany doesn't preserve the `in` order — walk the line-item order so
    // "the first ticket wins" means the first LINE's ticket, not an arbitrary row.
    const byId = new Map(rows.map(r => [r.id, r]));
    const tickets = ticketIds.map(id => byId.get(id)).filter((t): t is NonNullable<typeof t> => !!t);
    for (const t of tickets) {
      if (!division) division = t.division ?? defaultDivisionForWork(t);
      if (!isDickinson && t.isDickinson) isDickinson = true;
      if (!location) location = qbLocationLabel(t);
    }
    const labels = new Set(tickets.map(t => qbLocationLabel(t)).filter(Boolean));
    if (labels.size > 1) {
      console.warn(
        `[QBWC] Invoice ${invoice.invoiceNumber}: source tickets span ${labels.size} locations ` +
          `(${[...labels].join(', ')}) — sending "${location}" as the QB LOCATION.`,
      );
    }
  }

  // Shop work orders: always D6 (FEX), and the intake shop decides whether it's
  // the Dickinson class. The "location" is the shop that took the unit in.
  if (invoice.shopWorkOrderId) {
    const wo = await prisma.shopWorkOrder.findUnique({
      where: { id: invoice.shopWorkOrderId },
      select: { intakeSite: { select: { name: true, shortCode: true } } },
    });
    division = division ?? SHOP_DIVISION;
    if (!isDickinson && wo?.intakeSite?.shortCode === DICKINSON_SITE_SHORT_CODE) isDickinson = true;
    location = location ?? truncateQbOther(wo?.intakeSite?.name);
  }

  // Rentals bill as D4; the delivery site is the location.
  if (invoice.rentalAgreementId) {
    const rental = await prisma.rentalAgreement.findUnique({
      where: { id: invoice.rentalAgreementId },
      select: {
        well: { select: { wellName: true } },
        pad: { select: { name: true } },
        facility: { select: { name: true } },
        field: { select: { name: true } },
      },
    });
    division = division ?? RENTAL_DEFAULT_DIVISION;
    location = location ?? qbLocationLabel(rental);
  }

  if (!division) {
    // Every work type we bill now maps to a division, so this means the source
    // work is something new (or the invoice has no source at all). Say so out
    // loud rather than letting AR find a blank CLASS in QuickBooks.
    console.warn(
      `[QBWC ALERT] Invoice ${invoice.invoiceNumber}: no division resolved — QB CLASS will be blank. ` +
        `Set a division on the source work, or map the work type in utils/qbClass.ts.`,
    );
  }

  return { division, isDickinson, location };
}

function cleanQbHeaderText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function combinePoAfeForQb(poNumber: string | null, afeNumber: string | null): string | null {
  const po = cleanQbHeaderText(poNumber);
  const afe = cleanQbHeaderText(afeNumber);
  if (po && afe && po.toLowerCase() !== afe.toLowerCase()) return `${po} / ${afe}`;
  return po || afe;
}

function firstPicName(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const rawName = (entry as { name?: unknown }).name;
    const name = typeof rawName === 'string' ? cleanQbHeaderText(rawName) : null;
    if (name) return name;
  }
  return null;
}

/**
 * Build the shared QB document payload (customer + header + tax item + lines)
 * from an Invoice record. Consumed by both the SalesOrderAdd (opt-in) and
 * InvoiceAdd (default) builders — the only difference downstream is the QB
 * request type.
 */
export async function buildQbDocDataFromInvoice(invoiceId: string): Promise<QbSalesOrderData> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      company: {
        select: { qbCustomerListId: true, qbCustomerFullName: true, name: true },
      },
      lineItems: {
        orderBy: { sortOrder: 'asc' },
        include: {
          product: { select: { qbItemListId: true, qbItemFullName: true } },
        },
      },
    },
  });

  if (!invoice) throw new Error(`Invoice ${invoiceId} not found`);
  if (invoice.status === 'void' || (invoice.customData as any)?.billingWaiver) throw new Error('Billing was voided or waived; cannot send to QuickBooks');

  // Wave 5 Slice 5A — billing-rules customer override.
  // When the invoice carries a qbCustomerOverride (set by a billing rule
  // like the Tier 1 Pale Horse pass-through), look up the override company
  // by name and use its QB customer mapping instead of the invoice's actual
  // company. The override flows ONLY to QB — the SP invoice and Enverus
  // submission still use the actual operator.
  let customerListId: string | null = invoice.company?.qbCustomerListId || null;
  let customerFullName: string | null = invoice.company?.qbCustomerFullName || invoice.company?.name || invoice.companyName;

  if (invoice.qbCustomerOverride) {
    const overrideCompany = await prisma.company.findFirst({
      where: { name: { equals: invoice.qbCustomerOverride, mode: 'insensitive' } },
      select: { qbCustomerListId: true, qbCustomerFullName: true, name: true },
    });
    if (overrideCompany) {
      customerListId = overrideCompany.qbCustomerListId || null;
      customerFullName = overrideCompany.qbCustomerFullName
        || overrideCompany.name
        || invoice.qbCustomerOverride;
      console.log(
        `[QBWC] Invoice ${invoice.invoiceNumber}: customer overridden to "${customerFullName}" via billing rule (matched company ${overrideCompany.name})`,
      );
    } else {
      // No matching Sundog company. Push will use the override string as
      // FullName ref — QB will reject if that name isn't on its customer
      // list. Loud warning so the failure is traceable.
      customerListId = null;
      customerFullName = invoice.qbCustomerOverride;
      console.warn(
        `[QBWC ALERT] Invoice ${invoice.invoiceNumber}: qbCustomerOverride "${invoice.qbCustomerOverride}" — no matching company on file in Sundog. ` +
          `QBWC will push with this literal name as FullName ref; QB will reject if no customer with that exact name exists.`,
      );
    }
  }

  if (!customerListId && !customerFullName) {
    throw new Error(`Invoice ${invoice.invoiceNumber}: company has no QB customer mapping`);
  }

  // Wave 5 Slice 5A — drop lines flagged qbSkip (Tier 1 surcharge etc.).
  // These ride on the SP invoice + Enverus push but are intentionally
  // excluded from QB.
  const billableLines = invoice.lineItems.filter(li => !li.qbSkip);
  const skippedCount = invoice.lineItems.length - billableLines.length;
  if (skippedCount > 0) {
    console.log(
      `[QBWC] Invoice ${invoice.invoiceNumber}: skipping ${skippedCount} qbSkip line${skippedCount === 1 ? '' : 's'} (billing rule)`,
    );
  }

  const lines: QbSalesOrderLine[] = billableLines.map(li => ({
    qbItemListId: li.qbItemListId || li.product?.qbItemListId || null,
    qbItemFullName: li.qbItemFullName || li.product?.qbItemFullName || null,
    description: li.description || '',
    quantity: typeof li.quantity === 'object' ? parseFloat(li.quantity.toString()) : (li.quantity as number),
    rate: typeof li.rate === 'object' ? li.rate.toString() : String(li.rate || '0'),
    amount: typeof li.amount === 'object' ? li.amount.toString() : String(li.amount || '0'),
    isTaxable: li.isTaxable,
  }));

  // ND sales tax — map the invoice's jurisdiction to its QB Sales Tax Item so
  // QB recomputes the same tax total. Per-line SalesTaxCodeRef (above) honors
  // overrides; this header ref supplies the rate.
  let salesTaxItemFullName: string | null = null;
  if (invoice.taxJurisdictionId) {
    const jur = await prisma.salesTaxRate.findUnique({
      where: { id: invoice.taxJurisdictionId },
      select: { qbTaxItemName: true },
    });
    salesTaxItemFullName = jur?.qbTaxItemName || null;
  }

  if (lines.length === 0) {
    throw new Error(`Invoice ${invoice.invoiceNumber}: no billable line items (after qbSkip filter)`);
  }

  // Warn about lines without QB item mappings
  const unmapped = lines.filter(l => !l.qbItemListId && !l.qbItemFullName);
  if (unmapped.length > 0) {
    console.warn(`[QBWC] Invoice ${invoice.invoiceNumber}: ${unmapped.length} line(s) have no QB item mapping`);
  }

  const cls = await resolveInvoiceClassAndLocation(invoice);
  const classFullName = resolveQbClassFullName(cls.division, cls.isDickinson);
  const serviceDate = invoice.periodEnd || invoice.invoiceDate;

  const sourceTicketIds = [...new Set(
    invoice.lineItems.map(li => li.sourceTicketId).filter((id): id is string => !!id),
  )];
  const sourceTickets = sourceTicketIds.length
    ? await prisma.serviceTicket.findMany({
        where: { id: { in: sourceTicketIds } },
        select: { id: true, ticketNumber: true, serviceDate: true, customerRepName: true, poNumber: true, afeNumber: true, customData: true },
      })
    : [];
  const ticketById = new Map(sourceTickets.map(t => [t.id, t]));
  const orderedTickets = sourceTicketIds.map(id => ticketById.get(id)).filter((t): t is NonNullable<typeof t> => !!t);

  const rental = invoice.rentalAgreementId
    ? await prisma.rentalAgreement.findUnique({
        where: { id: invoice.rentalAgreementId },
        select: { agreementNumber: true, siteContactName: true, pics: true },
      })
    : null;
  const shopWorkOrder = invoice.shopWorkOrderId
    ? await prisma.shopWorkOrder.findUnique({
        where: { id: invoice.shopWorkOrderId },
        select: { workOrderNumber: true, pickupContactName: true, dropOffContactName: true },
      })
    : null;
  const rentalTickets = invoice.rentalAgreementId
    ? await prisma.serviceTicket.findMany({
        where: {
          linkedRentalAgreementId: invoice.rentalAgreementId,
          status: { not: 'void' },
          ...(invoice.periodStart && invoice.periodEnd
            ? { serviceDate: { gte: invoice.periodStart, lte: invoice.periodEnd } }
            : {}),
        },
        select: { id: true, ticketNumber: true, serviceDate: true, customerRepName: true, poNumber: true, afeNumber: true, customData: true },
        orderBy: { serviceDate: 'asc' },
      })
    : [];
  const sourceTicketIdSet = new Set(sourceTickets.map(t => t.id));
  const allHeaderTickets = [
    ...orderedTickets,
    ...rentalTickets.filter(t => !sourceTicketIdSet.has(t.id)),
  ];
  const firstTicketNumber = allHeaderTickets
    .map(t => cleanQbHeaderText(t.ticketNumber))
    .find((n): n is string => !!n);

  const memo = invoice.rentalAgreementId
    ? cleanQbHeaderText(rental?.agreementNumber) || firstTicketNumber
    : firstTicketNumber || cleanQbHeaderText(shopWorkOrder?.workOrderNumber);
  const fob = allHeaderTickets
    .map(t => firstPicName((t.customData as any)?.pics) || cleanQbHeaderText(t.customerRepName))
    .find((name): name is string => !!name)
    || firstPicName(rental?.pics)
    || cleanQbHeaderText(rental?.siteContactName)
    || cleanQbHeaderText(shopWorkOrder?.pickupContactName)
    || cleanQbHeaderText(shopWorkOrder?.dropOffContactName);
  const poNumber = cleanQbHeaderText(invoice.poNumber)
    || allHeaderTickets.map(t => cleanQbHeaderText(t.poNumber)).find((v): v is string => !!v)
    || null;
  const afeNumber = cleanQbHeaderText(invoice.afeNumber)
    || allHeaderTickets.map(t => cleanQbHeaderText(t.afeNumber)).find((v): v is string => !!v)
    || null;

  const data: QbSalesOrderData = {
    customerListId,
    customerFullName,
    txnDate: invoice.invoiceDate,
    refNumber: invoice.invoiceNumber,
    poNumber: combinePoAfeForQb(poNumber, afeNumber),
    fob,
    memo,
    classFullName,
    otherLocation: cls.location,
    salesTaxItemFullName,
    lines: lines.map(line => ({ ...line, serviceDate })),
  };

  return data;
}

/**
 * Build a SalesOrderAdd qbXML request from an Invoice record (opt-in legacy
 * path for customers flagged Company.qbUsesSalesOrder).
 */
async function buildSalesOrderFromInvoice(invoiceId: string): Promise<string> {
  return buildSalesOrderAdd(await buildQbDocDataFromInvoice(invoiceId));
}

/**
 * Build an InvoiceAdd qbXML request from an Invoice record (default path —
 * posts a real QB Invoice directly to A/R).
 */
async function buildInvoiceAddFromInvoice(invoiceId: string): Promise<string> {
  return buildInvoiceAdd(await buildQbDocDataFromInvoice(invoiceId));
}

/**
 * Build a SalesReceiptAdd qbXML request from a Payment record.
 *
 * For CC payments: PaymentMethod = Visa/MasterCard/etc, CheckNumber = Stripe charge ID
 * For cash/check: PaymentMethod = Cash/Check
 */
async function buildSalesReceiptFromPayment(paymentId: string): Promise<string> {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
      company: { select: { qbCustomerListId: true, qbCustomerFullName: true, name: true, taxExempt: true } },
      ticket: {
        include: {
          company: { select: { qbCustomerListId: true, qbCustomerFullName: true, name: true } },
          lineItems: {
            orderBy: { lineNumber: 'asc' },
            include: { product: { select: { qbItemListId: true, qbItemFullName: true } } },
          },
        },
      },
      shopWorkOrder: {
        include: {
          company: { select: { qbCustomerListId: true, qbCustomerFullName: true, name: true } },
          items: {
            include: { product: { select: { qbItemListId: true, qbItemFullName: true, name: true, defaultSellPrice: true } } },
          },
        },
      },
    },
  });

  if (!payment) throw new Error(`Payment ${paymentId} not found`);

  // Determine customer ref
  let customerListId: string | null = null;
  let customerFullName: string | null = null;
  let lines: QbSalesOrderLine[] = [];
  let refLabel = `PMT-${payment.id.substring(0, 8)}`;
  let salesTaxItemFullName: string | null = null;

  // Direct-sale counter receipt — rebuild from the persisted pre-tax basket so
  // QB recomputes tax via ItemSalesTaxRef to match the counter total. Sending a
  // single tax-inclusive line would double-tax.
  const snapshot = payment.lineItemsJson as Array<{
    productId?: string | null; description?: string; quantity?: number; unitPrice?: number; taxable?: boolean;
  }> | null;

  if (snapshot && Array.isArray(snapshot) && snapshot.length > 0) {
    const co = payment.company;
    customerListId = co?.qbCustomerListId || null;
    customerFullName = co?.qbCustomerFullName || co?.name || null;
    const taxExempt = co?.taxExempt ?? false;

    // Resolve QB item mappings for product-backed lines in one query.
    const productIds = snapshot.map(l => l.productId).filter((x): x is string => !!x);
    const products = productIds.length
      ? await prisma.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, qbItemListId: true, qbItemFullName: true, name: true },
        })
      : [];
    const productMap = new Map(products.map(p => [p.id, p]));

    lines = snapshot.map(l => {
      const p = l.productId ? productMap.get(l.productId) : undefined;
      const qty = Number(l.quantity) || 1;
      const unit = Number(l.unitPrice) || 0;
      return {
        qbItemListId: p?.qbItemListId || null,
        qbItemFullName: p?.qbItemFullName || p?.name || null,
        description: l.description || p?.name || '',
        quantity: qty,
        rate: String(unit),
        amount: String(unit * qty),
        isTaxable: !taxExempt && !!l.taxable,
      };
    });

    // Jurisdiction → QB Sales Tax Item. Only when a line is taxable and the
    // customer isn't exempt; otherwise QB books no tax.
    if (payment.taxJurisdictionId && !taxExempt && lines.some(l => l.isTaxable)) {
      const jur = await prisma.salesTaxRate.findUnique({
        where: { id: payment.taxJurisdictionId },
        select: { qbTaxItemName: true },
      });
      salesTaxItemFullName = jur?.qbTaxItemName || null;
    }
  } else if (payment.ticket) {
    const co = payment.ticket.company;
    customerListId = co?.qbCustomerListId || null;
    customerFullName = co?.qbCustomerFullName || co?.name || null;
    refLabel = payment.ticket.ticketNumber;

    lines = payment.ticket.lineItems.map(li => ({
      qbItemListId: li.product?.qbItemListId || null,
      qbItemFullName: li.product?.qbItemFullName || null,
      description: li.description || '',
      quantity: typeof li.quantity === 'object' ? parseFloat(li.quantity.toString()) : (li.quantity as number),
      rate: li.rate != null ? (typeof li.rate === 'object' ? li.rate.toString() : String(li.rate)) : '0',
      amount: li.total != null ? (typeof li.total === 'object' ? li.total.toString() : String(li.total)) : '0',
    }));
  } else if (payment.shopWorkOrder) {
    const co = payment.shopWorkOrder.company;
    customerListId = co?.qbCustomerListId || null;
    customerFullName = co?.qbCustomerFullName || co?.name || null;
    refLabel = payment.shopWorkOrder.workOrderNumber;

    lines = payment.shopWorkOrder.items.map(item => ({
      qbItemListId: item.product?.qbItemListId || null,
      qbItemFullName: item.product?.qbItemFullName || item.product?.name || null,
      description: item.equipmentDescription || item.serialNumber || '',
      quantity: 1,
      rate: item.estimatedCost ? item.estimatedCost.toString() : '0',
      amount: item.estimatedCost ? item.estimatedCost.toString() : '0',
    }));
  }

  // Fallback: if no lines from ticket/shop, create a single line for the payment amount
  if (lines.length === 0) {
    lines = [{
      description: payment.notes || 'Payment',
      quantity: 1,
      rate: payment.amount.toString(),
      amount: payment.amount.toString(),
    }];
  }

  if (!customerListId && !customerFullName) {
    // Walk-in customer fallback
    customerFullName = process.env.QB_WALKIN_CUSTOMER || 'Walk In Purchase';
  }

  // Map payment method to QB PaymentMethod name
  let paymentMethodName = 'Cash';
  let checkNumber: string | null = null;
  if (payment.paymentMethod === 'credit_card') {
    paymentMethodName = payment.cardBrand
      ? payment.cardBrand.charAt(0).toUpperCase() + payment.cardBrand.slice(1)
      : 'Visa';
    checkNumber = payment.stripeChargeId || payment.stripePaymentIntentId || null;
  } else if (payment.paymentMethod === 'check') {
    paymentMethodName = 'Check';
  }

  const memo = payment.paymentMethod === 'credit_card'
    ? `CC conf: ${payment.stripePaymentIntentId || ''} • card ending ${payment.cardLast4 || '****'}`
    : `${paymentMethodName} payment — ${refLabel}`;

  const data: QbSalesReceiptData = {
    customerListId,
    customerFullName,
    txnDate: payment.createdAt,
    refNumber: refLabel,
    paymentMethodName,
    checkNumber,
    memo,
    salesTaxItemFullName,
    lines,
  };

  return buildSalesReceiptAdd(data);
}

/**
 * Process QB's response for a queue entry.
 */
async function processQbResponse(
  entry: { id: string; entityType: string; action: string; entityId: string },
  responseXml: string,
  hresult: string,
  message: string,
): Promise<void> {
  // QBWC-level error (connection/transport issue)
  if (hresult) {
    const retryCount = (await prisma.qbSyncQueue.findUnique({ where: { id: entry.id } }))?.retryCount || 0;
    await prisma.qbSyncQueue.update({
      where: { id: entry.id },
      data: {
        status: retryCount + 1 >= MAX_RETRIES ? 'error' : 'pending',
        errorMessage: `QBWC error: ${hresult} - ${message}`,
        errorCode: hresult,
        retryCount: retryCount + 1,
        qbxmlResponse: responseXml || null,
        completedAt: retryCount + 1 >= MAX_RETRIES ? new Date() : null,
        sentAt: null, // reset so it gets picked up again
      },
    });
    return;
  }

  // ---------------------------------------------------------------------------
  // InvoiceAdd response — the default path. Posts a real QB Invoice directly,
  // so on success the invoice is immediately "invoiced" (no SO→Invoice poll).
  // ---------------------------------------------------------------------------
  if (entry.entityType === 'invoice' && entry.action === 'add') {
    const result = parseInvoiceAddResponse(responseXml);

    if (result.statusCode === '0') {
      console.log(`[QBWC] InvoiceAdd OK: INV# ${result.refNumber} (TxnID ${result.txnId})`);

      await prisma.qbSyncQueue.update({
        where: { id: entry.id },
        data: {
          status: 'success',
          qbxmlResponse: responseXml,
          completedAt: new Date(),
        },
      });

      const invoiced = await prisma.invoice.update({
        where: { id: entry.entityId },
        data: {
          status: 'invoiced',
          qbInvoiceTxnId: result.txnId,
          qbInvoiceNumber: result.refNumber,
          qbInvoiceCreatedAt: new Date(),
        },
      });
      // No conversion poll needed — the diff watcher picks this up via qbInvoiceTxnId.

      // Keep billing_doc_ref.qbTxnId current (services/billingLineage.ts —
      // same upsert the invoice-creation routes call).
      await upsertDocRefAndLines(invoiced.id);

      // Mirror — billing_observation, not a bare column. Fact value is
      // exactly what QB returned (txnId/refNumber) — never fabricate an
      // invoice_date from a modification timestamp; that fact gets mirrored
      // separately once the diff-watcher's InvoiceQuery actually reads TxnDate.
      if (result.timeModified) {
        await recordDocRefObservationByDocNumber(prisma, invoiced.invoiceNumber, {
          factKey: 'qb_txn_id',
          factValue: { qbTxnId: result.txnId, qbInvoiceNumber: result.refNumber },
          source: 'quickbooks',
          asOf: new Date(result.timeModified),
        });
      }
    } else {
      console.error(`[QBWC] InvoiceAdd error: ${result.statusCode} ${result.statusSeverity} - ${result.statusMessage}`);

      const current = await prisma.qbSyncQueue.findUnique({ where: { id: entry.id } });
      const retryCount = (current?.retryCount || 0) + 1;
      const shouldRetry = result.statusSeverity !== 'Error' && retryCount < MAX_RETRIES;

      await prisma.qbSyncQueue.update({
        where: { id: entry.id },
        data: {
          status: shouldRetry ? 'pending' : 'error',
          errorMessage: `QB ${result.statusCode}: ${result.statusMessage}`,
          errorCode: result.statusCode,
          retryCount,
          qbxmlResponse: responseXml,
          completedAt: shouldRetry ? null : new Date(),
          sentAt: shouldRetry ? null : undefined,
        },
      });
    }
    return;
  }

  if (entry.entityType === 'sales_order' && entry.action === 'add') {
    const result = parseSalesOrderResponse(responseXml);

    if (result.statusCode === '0') {
      // Success!
      console.log(`[QBWC] SalesOrderAdd OK: SO# ${result.refNumber}`);

      await prisma.qbSyncQueue.update({
        where: { id: entry.id },
        data: {
          status: 'success',
          qbxmlResponse: responseXml,
          completedAt: new Date(),
        },
      });

      const soCreated = await prisma.invoice.update({
        where: { id: entry.entityId },
        data: {
          status: 'so_created',
          qbSalesOrderTxnId: result.txnId,
          qbSalesOrderNumber: result.refNumber,
          qbSalesOrderPushedAt: new Date(),
        },
      });

      // Mirror — see the InvoiceAdd handler above for why this is a bare
      // qb_txn_id fact, not a fabricated invoice_date.
      if (result.timeModified) {
        await recordDocRefObservationByDocNumber(prisma, soCreated.invoiceNumber, {
          factKey: 'qb_txn_id',
          factValue: { qbSalesOrderTxnId: result.txnId, qbSalesOrderNumber: result.refNumber },
          source: 'quickbooks',
          asOf: new Date(result.timeModified),
        });
      }

      // Auto-queue an InvoiceQuery to check for SO→Invoice conversion
      // Lower priority (10) so it runs after all pending SalesOrderAdds
      await queueInvoiceQuery(entry.entityId);
    } else {
      // QB returned an error
      console.error(`[QBWC] SalesOrderAdd error: ${result.statusCode} ${result.statusSeverity} - ${result.statusMessage}`);

      const current = await prisma.qbSyncQueue.findUnique({ where: { id: entry.id } });
      const retryCount = (current?.retryCount || 0) + 1;
      const shouldRetry = result.statusSeverity !== 'Error' && retryCount < MAX_RETRIES;

      await prisma.qbSyncQueue.update({
        where: { id: entry.id },
        data: {
          status: shouldRetry ? 'pending' : 'error',
          errorMessage: `QB ${result.statusCode}: ${result.statusMessage}`,
          errorCode: result.statusCode,
          retryCount,
          qbxmlResponse: responseXml,
          completedAt: shouldRetry ? null : new Date(),
          sentAt: shouldRetry ? null : undefined,
        },
      });
    }
    return;
  }

  // ---------------------------------------------------------------------------
  // SalesReceiptAdd response — update Payment with QB TxnID
  // ---------------------------------------------------------------------------
  if (entry.entityType === 'sales_receipt' && entry.action === 'add') {
    const result = parseSalesReceiptResponse(responseXml);

    if (result.statusCode === '0') {
      console.log(`[QBWC] SalesReceiptAdd OK: SR# ${result.refNumber}`);

      await prisma.qbSyncQueue.update({
        where: { id: entry.id },
        data: {
          status: 'success',
          qbxmlResponse: responseXml,
          completedAt: new Date(),
        },
      });

      const paidPayment = await prisma.payment.update({
        where: { id: entry.entityId },
        data: { qbSalesReceiptTxnId: result.txnId },
        select: { amount: true, invoice: { select: { invoiceNumber: true } } },
      });

      // Mirror the money actually landing — the ADR's "paid"/"amount_paid"
      // facts. This is the one QB-sourced fact no prior code path produced at
      // all (see the Phase 1 audit): a SalesReceipt against an invoice is the
      // closest signal ServicePRO has today that an invoice got paid.
      if (result.timeModified && paidPayment.invoice) {
        await recordDocRefObservationByDocNumber(prisma, paidPayment.invoice.invoiceNumber, {
          factKey: 'paid',
          factValue: { amountPaid: paidPayment.amount.toString(), qbSalesReceiptTxnId: result.txnId },
          source: 'quickbooks',
          asOf: new Date(result.timeModified),
        });
      }
    } else {
      console.error(`[QBWC] SalesReceiptAdd error: ${result.statusCode} ${result.statusSeverity} - ${result.statusMessage}`);

      const current = await prisma.qbSyncQueue.findUnique({ where: { id: entry.id } });
      const retryCount = (current?.retryCount || 0) + 1;
      const shouldRetry = result.statusSeverity !== 'Error' && retryCount < MAX_RETRIES;

      await prisma.qbSyncQueue.update({
        where: { id: entry.id },
        data: {
          status: shouldRetry ? 'pending' : 'error',
          errorMessage: `QB ${result.statusCode}: ${result.statusMessage}`,
          errorCode: result.statusCode,
          retryCount,
          qbxmlResponse: responseXml,
          completedAt: shouldRetry ? null : new Date(),
          sentAt: shouldRetry ? null : undefined,
        },
      });
    }
    return;
  }

  // ---------------------------------------------------------------------------
  // Invoice query response — branch on whether this is a diff check
  // (qbInvoiceTxnId already set; comparing QB state to Sundog) or the
  // SO→Invoice conversion check (qbInvoiceTxnId still null).
  // ---------------------------------------------------------------------------
  if (entry.entityType === 'invoice' && entry.action === 'query') {
    const invoiceForBranching = await prisma.invoice.findUnique({
      where: { id: entry.entityId },
      select: { qbInvoiceTxnId: true, total: true, invoiceNumber: true, lineItems: { select: { id: true } } },
    });

    if (invoiceForBranching?.qbInvoiceTxnId) {
      const diff = parseInvoiceDiffResponse(responseXml);
      await prisma.qbSyncQueue.update({
        where: { id: entry.id },
        data: {
          status: 'success',
          qbxmlResponse: responseXml.slice(0, 30000),
          completedAt: new Date(),
        },
      });

      if (!diff.found) {
        // QB has no record for our TxnID — could be a void on QB's side.
        // Flag as a diff with a clear note; don't keep retrying every cycle.
        await prisma.invoice.update({
          where: { id: entry.entityId },
          data: {
            qbDiffDetectedAt: new Date(),
            qbDiffNotes: {
              kind: 'qb_record_missing',
              ourTotal: invoiceForBranching.total ? Number(invoiceForBranching.total) : null,
              theirTotal: null,
              ourLineCount: invoiceForBranching.lineItems.length,
              theirLineCount: 0,
              statusCode: diff.statusCode,
              statusMessage: diff.statusMessage,
              checkedAt: new Date().toISOString(),
            },
            qbLastCheckedAt: new Date(),
          },
        });
        console.warn(
          `[QBWC Diff] Invoice ${invoiceForBranching.invoiceNumber} not found in QB (TxnID stale or voided)`,
        );
        // No mirror write here — "not found" carries no QB-asserted timestamp
        // to use as as_of, and Rule 3 forbids stamping the sync-run time in
        // its place. qbDiffDetectedAt above already surfaces this to ops.
      } else {
        const ourTotal = invoiceForBranching.total ? Number(invoiceForBranching.total) : 0;
        const theirTotal = diff.qbTotal ?? 0;
        const ourLineCount = invoiceForBranching.lineItems.length;
        const theirLineCount = diff.qbLineCount;
        // 1¢ tolerance — float math from Decimal coercion shouldn't trip this.
        const totalsDiverge = Math.abs(ourTotal - theirTotal) > 0.01;
        const linesDiverge = ourLineCount !== theirLineCount;

        if (totalsDiverge || linesDiverge) {
          await prisma.invoice.update({
            where: { id: entry.entityId },
            data: {
              qbDiffDetectedAt: new Date(),
              qbDiffNotes: {
                kind: totalsDiverge ? 'total_mismatch' : 'line_count_mismatch',
                ourTotal,
                theirTotal,
                ourLineCount,
                theirLineCount,
                qbTimeModified: diff.qbTimeModified,
                checkedAt: new Date().toISOString(),
              },
              qbLastCheckedAt: new Date(),
            },
          });
          console.warn(
            `[QBWC Diff] Invoice ${invoiceForBranching.invoiceNumber} diverges: ` +
              `ours $${ourTotal.toFixed(2)} (${ourLineCount} lines) vs QB $${theirTotal.toFixed(2)} (${theirLineCount} lines)`,
          );
          if (diff.qbTimeModified) {
            await recordDocRefObservationByDocNumber(prisma, invoiceForBranching.invoiceNumber, {
              factKey: totalsDiverge ? 'total_mismatch' : 'line_count_mismatch',
              factValue: { ourTotal, theirTotal, ourLineCount, theirLineCount },
              source: 'quickbooks',
              asOf: new Date(diff.qbTimeModified),
            });
          }
        } else {
          // In sync — clear any prior flag.
          await prisma.invoice.update({
            where: { id: entry.entityId },
            data: {
              qbDiffDetectedAt: null,
              qbDiffNotes: null as any,
              qbLastCheckedAt: new Date(),
            },
          });
        }
      }
      return;
    }
  }

  // ---------------------------------------------------------------------------
  // SO→Invoice check — parse SalesOrderQuery response for linked Invoice
  // ---------------------------------------------------------------------------
  if (entry.entityType === 'invoice' && entry.action === 'query') {
    const result = parseInvoiceQueryResponse(responseXml);

    if (result.found) {
      console.log(`[QBWC] SO→Invoice converted: ${result.invoiceRefNumber || 'detected via SO'}`);

      await prisma.qbSyncQueue.update({
        where: { id: entry.id },
        data: {
          status: 'success',
          qbxmlResponse: responseXml,
          completedAt: new Date(),
        },
      });

      // Update the invoice → status "invoiced"
      // QB Invoice TxnID/number may be null if detected via SO IsFullyInvoiced
      const updateData: Record<string, any> = {
        status: 'invoiced',
      };
      if (result.invoiceTxnId) updateData.qbInvoiceTxnId = result.invoiceTxnId;
      if (result.invoiceRefNumber) updateData.qbInvoiceNumber = result.invoiceRefNumber;
      if (result.invoiceDate) updateData.qbInvoiceCreatedAt = new Date(result.invoiceDate);
      if (!updateData.qbInvoiceCreatedAt) updateData.qbInvoiceCreatedAt = new Date();

      const converted = await prisma.invoice.update({
        where: { id: entry.entityId },
        data: updateData,
      });

      // Keep billing_doc_ref.qbTxnId current (this also creates the doc_ref
      // if it somehow doesn't exist yet).
      await upsertDocRefAndLines(converted.id);

      // result.invoiceDate is QB's own TxnDate — a genuine accounting fact,
      // more authoritative here than our own Invoice.invoiceDate (which is
      // ServicePRO's generation-time date, untouched by this handler — Rule
      // 4: service date and invoice date stay separate forever, and this is
      // specifically the invoice-date side). upsertDocRefAndLines above
      // wouldn't know this; patch it directly, same as its own reconciliation
      // (only qbTxnId/invoiceDate — the columns the trigger allows to change).
      if (result.invoiceDate) {
        const docRef = await prisma.billingDocRef.findFirst({ where: { docNumber: converted.invoiceNumber, revision: 1 } });
        if (docRef) {
          await prisma.billingDocRef.update({
            where: { id: docRef.id },
            data: { invoiceDate: new Date(result.invoiceDate) },
          });
        }
        await recordDocRefObservationByDocNumber(prisma, converted.invoiceNumber, {
          factKey: 'invoice_date',
          factValue: { invoiceDate: result.invoiceDate, qbTxnId: result.invoiceTxnId, qbInvoiceNumber: result.invoiceRefNumber },
          source: 'quickbooks',
          asOf: new Date(result.invoiceDate),
        });
      }

    } else {
      // Not converted yet — wait for next QBWC poll cycle to check again
      const isNormalNoMatch = result.statusCode === '1' || result.statusCode === '0';

      if (isNormalNoMatch) {

        // Mark this query as done — but DON'T re-queue immediately.
        // Re-queuing here causes all 10 attempts to burn in one QBWC session
        // before the comptroller has time to convert the SO→Invoice.
        // Instead, re-queue at the START of the next QBWC session (in handleAuthenticate).
        await prisma.qbSyncQueue.update({
          where: { id: entry.id },
          data: {
            status: 'success',
            qbxmlResponse: responseXml,
            completedAt: new Date(),
          },
        });

        console.log(`[QBWC] SO not yet invoiced for ${entry.entityId} — will re-check next QBWC cycle`);
      } else {
        // Actual error from QB
        console.error(`[QBWC] InvoiceQuery error: ${result.statusCode} - ${result.statusMessage}`);

        const current = await prisma.qbSyncQueue.findUnique({ where: { id: entry.id } });
        const retryCount = (current?.retryCount || 0) + 1;

        await prisma.qbSyncQueue.update({
          where: { id: entry.id },
          data: {
            status: retryCount >= MAX_RETRIES ? 'error' : 'pending',
            errorMessage: `QB ${result.statusCode}: ${result.statusMessage}`,
            errorCode: result.statusCode,
            retryCount,
            qbxmlResponse: responseXml,
            completedAt: retryCount >= MAX_RETRIES ? new Date() : null,
            sentAt: retryCount >= MAX_RETRIES ? undefined : null,
          },
        });
      }
    }
    return;
  }

  // ---------------------------------------------------------------------------
  // Item Query response — sync products from QB
  // ---------------------------------------------------------------------------
  if (entry.entityType === 'item' && entry.action === 'query') {
    const items = parseItemQueryResponse(responseXml);
    const pulledAt = new Date();
    let updated = 0;
    let created = 0;
    let skippedConflict = 0;
    let skippedInactive = 0;
    const createdNames: string[] = [];
    const conflicts: string[] = [];

    for (const item of items) {
      try {
        // Match on the stable QB ListID first. Fall back to the part number only
        // when no ListID match exists — and NEVER adopt a product that's already
        // bound to a DIFFERENT QB item. A blind `OR: [listId, partNumber==fullName]`
        // with findFirst can pick the wrong row and stamp QB's name/ref/price onto
        // it, scrambling the catalog (this is how part 115 became "Area Gas Monitor
        // Rental / QB 315").
        let existing = await prisma.product.findFirst({
          where: { qbItemListId: item.listId },
        });

        if (!existing) {
          // Two spellings to try: QB's full sub-item path and the item's own
          // name. Matching only the full path missed every product numbered by
          // the leaf — e.g. our "0800001" never matched QB's "Parts:0800001".
          const leaf = qbItemLeafName(item.fullName);
          const candidates = leaf === item.fullName ? [item.fullName] : [item.fullName, leaf];
          const byPart = await prisma.product.findFirst({
            where: { partNumber: { in: candidates } },
          });
          if (byPart?.qbItemListId && byPart.qbItemListId !== item.listId) {
            console.warn(
              `[QBWC] Item sync conflict: QB item "${item.fullName}" (${item.listId}) ` +
              `matches product ${byPart.id} by partNumber, but it is already bound to ` +
              `QB ListID ${byPart.qbItemListId}. Skipping to avoid overwriting the wrong product.`,
            );
            skippedConflict++;
            if (conflicts.length < 20) conflicts.push(leaf);
            continue;
          }
          existing = byPart;
        }

        // Nothing in Sundog matches this QB item — mint it. QB owns the item
        // list, so a part that exists there and not here is a gap in our
        // catalog, not a reason to drop the row: skipping was why a renumbered
        // QB part never showed up in Products or the ticket line picker.
        // Creating can't scramble anything (the conflict guard above already
        // ruled out every product that could be this item), and inactive QB
        // items are left alone until someone reactivates them.
        if (!existing) {
          if (!item.isActive) {
            skippedInactive++;
            continue;
          }
          const createData = productCreateFromQbItem(item, pulledAt);
          await prisma.product.create({
            data: {
              ...createData,
              ...partNumberFacetColumns(createData.partNumber),
            },
          });
          created++;
          if (createdNames.length < 25) createdNames.push(createData.partNumber);
          continue;
        }

        const updateData: Record<string, any> = {
          qbItemListId: item.listId,
          qbItemFullName: item.fullName,
          isActive: item.isActive,
        };

        // QB owns the item type — keep it in step (it drives the CSV/pull
        // product-type mapping and the v1 API's item classification).
        const pulledType = PRODUCT_TYPE_FOR_QB_ITEM_TYPE[item.itemType as keyof typeof PRODUCT_TYPE_FOR_QB_ITEM_TYPE];
        if (pulledType) updateData.qbItemType = item.itemType;

        // Only update fields if QB has values (don't blank out existing data)
        if (item.description) updateData.name = item.description;
        if (item.unitOfMeasure) updateData.unitOfMeasure = item.unitOfMeasure;
        if (item.price != null && item.price > 0) updateData.defaultSellPrice = item.price;

        // Company-wide renumber: when QB renames an item to a new-scheme
        // 7-digit division-prefixed number, adopt it as our partNumber (QB is
        // the numbering source of truth) — unless another product already
        // holds that number, in which case warn and keep the old one.
        if (
          item.fullName &&
          item.fullName !== existing.partNumber &&
          parsePartNumber(item.fullName)
        ) {
          const collision = await prisma.product.findFirst({
            where: { partNumber: item.fullName, NOT: { id: existing.id } },
            select: { id: true, partNumber: true },
          });
          if (collision) {
            console.warn(
              `[QBWC] Item sync: cannot adopt renamed part number "${item.fullName}" for ` +
              `product ${existing.id} — product ${collision.id} already holds it.`,
            );
          } else {
            updateData.partNumber = item.fullName;
          }
        }

        // Division facets are always derived from the (possibly updated)
        // part number so they can't drift from it.
        Object.assign(
          updateData,
          partNumberFacetColumns((updateData.partNumber as string | undefined) ?? existing.partNumber),
        );

        await prisma.product.update({
          where: { id: existing.id },
          data: updateData,
        });
        updated++;
      } catch (err) {
        // Non-fatal — continue with other items
        console.warn(`[QBWC] Item sync error for ${item.fullName}:`, err instanceof Error ? err.message : err);
      }
    }

    console.log(
      `[QBWC] Item sync complete: ${items.length} from QB, ${updated} updated, ${created} created, ` +
      `${skippedInactive} skipped (inactive in QB, not in Sundog), ${skippedConflict} skipped (mapping conflict)`,
    );
    if (createdNames.length > 0) {
      console.log(
        `[QBWC] Item sync created: ${createdNames.join(', ')}${created > createdNames.length ? ` … +${created - createdNames.length} more` : ''}`,
      );
    }
    if (conflicts.length > 0) {
      console.warn(`[QBWC] Item sync conflicts (left untouched): ${conflicts.join(', ')}`);
    }

    await prisma.qbSyncQueue.update({
      where: { id: entry.id },
      data: {
        status: 'success',
        qbxmlResponse: responseXml?.slice(0, 10000) || null,
        completedAt: new Date(),
        errorMessage: null,
      },
    });
    return;
  }

  // ---------------------------------------------------------------------------
  // Wave 5 5B — Price Level Query response: upsert into price_levels +
  // price_level_items. We replace each level's items wholesale on every pull
  // to mirror QB's authoritative state — additions/deletions on the QB side
  // both flow through cleanly without orphan rows.
  // ---------------------------------------------------------------------------
  if (entry.entityType === 'price_level' && entry.action === 'query') {
    const levels = parsePriceLevelQueryResponse(responseXml);
    let upserted = 0;
    let totalItems = 0;
    const now = new Date();

    for (const level of levels) {
      try {
        await prisma.$transaction(async (tx) => {
          const existing = await tx.priceLevel.findUnique({ where: { qbListId: level.qbListId } });
          const data = {
            name: level.name,
            isActive: level.isActive,
            qbCustomerListId: level.qbCustomerListId,
            qbCustomerName: level.qbCustomerName,
            qbTimeModified: level.qbTimeModified ? new Date(level.qbTimeModified) : null,
            lastSyncedAt: now,
          };
          let pl;
          if (existing) {
            pl = await tx.priceLevel.update({ where: { id: existing.id }, data });
            // Replace items wholesale — simpler than diff and keeps QB's
            // state authoritative.
            await tx.priceLevelItem.deleteMany({ where: { priceLevelId: pl.id } });
          } else {
            pl = await tx.priceLevel.create({ data: { qbListId: level.qbListId, ...data } });
          }
          if (level.items.length > 0) {
            await tx.priceLevelItem.createMany({
              data: level.items.map(item => ({
                priceLevelId: pl.id,
                qbItemListId: item.qbItemListId,
                qbItemFullName: item.qbItemFullName,
                customPrice: item.customPrice,
                adjustPercent: item.adjustPercent,
              })),
            });
            totalItems += level.items.length;
          }
        });
        upserted++;
      } catch (err) {
        console.warn(`[QBWC] Price level sync error for "${level.name}" (${level.qbListId}):`, err instanceof Error ? err.message : err);
      }
    }

    console.log(`[QBWC] Price level sync complete: ${levels.length} from QB, ${upserted} upserted, ${totalItems} per-item rules`);

    await prisma.qbSyncQueue.update({
      where: { id: entry.id },
      data: {
        status: 'success',
        qbxmlResponse: responseXml?.slice(0, 10000) || null,
        completedAt: new Date(),
        errorMessage: null,
      },
    });
    return;
  }

  // ---------------------------------------------------------------------------
  // Sales Tax Query response — mirror QB's tax items + groups into
  // qb_sales_tax_records so qbTaxItemName can be reconciled against real names.
  // ---------------------------------------------------------------------------
  if (entry.entityType === 'sales_tax' && entry.action === 'query') {
    const records = parseSalesTaxQueryResponse(responseXml);
    const now = new Date();
    let upserted = 0;

    for (const rec of records) {
      try {
        await prisma.qbSalesTaxRecord.upsert({
          where: { qbListId: rec.qbListId },
          update: {
            fullName: rec.fullName,
            recordType: rec.recordType,
            taxRatePercent: rec.taxRatePercent,
            isActive: rec.isActive,
            description: rec.description,
            qbTimeModified: rec.qbTimeModified ? new Date(rec.qbTimeModified) : null,
            lastSyncedAt: now,
          },
          create: {
            qbListId: rec.qbListId,
            fullName: rec.fullName,
            recordType: rec.recordType,
            taxRatePercent: rec.taxRatePercent,
            isActive: rec.isActive,
            description: rec.description,
            qbTimeModified: rec.qbTimeModified ? new Date(rec.qbTimeModified) : null,
            lastSyncedAt: now,
          },
        });
        upserted++;
      } catch (err) {
        console.warn(`[QBWC] Sales tax sync error for "${rec.fullName}" (${rec.qbListId}):`, err instanceof Error ? err.message : err);
      }
    }

    const itemCount = records.filter(r => r.recordType === 'item').length;
    const groupCount = records.length - itemCount;
    console.log(`[QBWC] Sales tax sync complete: ${records.length} from QB (${itemCount} items, ${groupCount} groups), ${upserted} upserted`);

    await prisma.qbSyncQueue.update({
      where: { id: entry.id },
      data: {
        status: 'success',
        qbxmlResponse: responseXml?.slice(0, 10000) || null,
        completedAt: new Date(),
        errorMessage: null,
      },
    });
    return;
  }

  // Fallback: mark as success (we got a response)
  await prisma.qbSyncQueue.update({
    where: { id: entry.id },
    data: {
      status: 'success',
      qbxmlResponse: responseXml,
      completedAt: new Date(),
    },
  });
}

// ---------------------------------------------------------------------------
// Auto-queue InvoiceQuery
// ---------------------------------------------------------------------------

/**
 * Queue an InvoiceQuery to check if an SO has been converted to an Invoice.
 *
 * Uses priority 10 (lower than SalesOrderAdd's default 5) so new SO pushes
 * always run first. Only queues if:
 *   1. The invoice still has status "so_created" (hasn't been manually marked)
 *   2. There isn't already a pending invoice/query in the queue for this invoice
 */
async function queueInvoiceQuery(invoiceId: string): Promise<void> {
  // Guard: only if invoice is still in so_created status
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { status: true, invoiceNumber: true },
  });

  if (!invoice || invoice.status !== 'so_created') {
    console.log(`[QBWC] Skip InvoiceQuery queue — invoice ${invoiceId} status: ${invoice?.status || 'not found'}`);
    return;
  }

  // Guard: don't stack up duplicate queries
  const existingQuery = await prisma.qbSyncQueue.findFirst({
    where: {
      entityType: 'invoice',
      action: 'query',
      entityId: invoiceId,
      status: { in: ['pending', 'sent'] },
    },
  });

  if (existingQuery) {
    console.log(`[QBWC] Skip InvoiceQuery queue — already pending for ${invoice.invoiceNumber}`);
    return;
  }

  // Guard: stop re-queuing after MAX_INVOICE_QUERY_ATTEMPTS (prevents infinite loop)
  // Each completed query attempt = one 'success' entry for this invoice/query
  const MAX_INVOICE_QUERY_ATTEMPTS = 10;
  const completedQueries = await prisma.qbSyncQueue.count({
    where: {
      entityType: 'invoice',
      action: 'query',
      entityId: invoiceId,
      status: 'success',
    },
  });

  if (completedQueries >= MAX_INVOICE_QUERY_ATTEMPTS) {
    console.log(`[QBWC] Skip InvoiceQuery for ${invoice.invoiceNumber} — exhausted ${completedQueries} attempts. SO not yet converted in QB.`);
    return;
  }

  await prisma.qbSyncQueue.create({
    data: {
      entityType: 'invoice',
      action: 'query',
      entityId: invoiceId,
      priority: 10,   // lower priority than SO pushes (5)
      status: 'pending',
    },
  });

  console.log(`[QBWC] Queued InvoiceQuery for ${invoice.invoiceNumber} (attempt ${completedQueries + 1}/${MAX_INVOICE_QUERY_ATTEMPTS})`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function progressResponse(session: QbwcSession): string {
  const total = Math.max(session.totalItems, 1);
  const pct = Math.min(Math.floor((session.processedItems / total) * 100), 99);

  // Check if there's more pending
  // (We return the percentage; if QBWC gets < 100, it calls sendRequestXML again)
  return soapEnvelope(`
    <tns:receiveResponseXMLResponse>
      <tns:receiveResponseXMLResult>${pct}</tns:receiveResponseXMLResult>
    </tns:receiveResponseXMLResponse>`);
}

/** Escape XML content for embedding inside a SOAP XML element */
function escapeXmlForSoap(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Unescape XML entities back to their characters.
 *
 * MUST resolve every entity in ONE pass. The old sequential-replace version
 * (`&amp;`→`&` first, then `&quot;`→`"`) double-decoded: QB writes a quote
 * inside statusMessage as `&quot;`, QBWC escapes that again to `&amp;quot;`
 * for the SOAP body, and decoding `&amp;` first left a live `&quot;` for the
 * later pass to turn into a raw `"`. That raw quote terminated the attribute
 * early in extractAttr(), which is why
 *   There was a required element ("TxnID") missing
 * landed in qb_sync_queue.error_message as
 *   There was a required element (
 * Same story for `&amp;lt;` → a raw `<` mid-attribute. A single pass leaves
 * the inner entity escaped, which is what the qbXML parser expects.
 */
function unescapeXml(s: string): string {
  return decodeHtmlEntities(s);
}

// ---------------------------------------------------------------------------
// Main SOAP endpoint — handles ALL QBWC calls
// ---------------------------------------------------------------------------

qbwcRouter.post('/soap', async (req: Request, res: Response) => {
  // QBWC sends raw XML with Content-Type: text/xml
  const soapAction = (req.headers['soapaction'] || '') as string;
  const contentType = req.headers['content-type'] || 'unknown';
  const body = typeof req.body === 'string' ? req.body : '';

  // Trim verbose per-request logging for production

  if (!body) {
    console.error(`[QBWC] Empty SOAP body! req.body type=${typeof req.body}, value=${JSON.stringify(req.body)?.substring(0, 200)}`);
    res.status(400).send('Empty SOAP body');
    return;
  }

  const method = detectMethod(soapAction, body);
  console.log(`[QBWC] → Method: ${method}`);

  let responseXml: string;

  try {
    switch (method) {
      case 'serverVersion':
        responseXml = handleServerVersion();
        break;
      case 'clientVersion':
        responseXml = handleClientVersion(body);
        break;
      case 'authenticate':
        responseXml = await handleAuthenticate(body);
        break;
      case 'sendRequestXML':
        responseXml = await handleSendRequestXML(body);
        break;
      case 'receiveResponseXML':
        responseXml = await handleReceiveResponseXML(body);
        break;
      case 'getLastError':
        responseXml = handleGetLastError(body);
        break;
      case 'closeConnection':
        responseXml = handleCloseConnection(body);
        break;
      case 'connectionError':
        responseXml = handleConnectionError(body);
        break;
      default:
        console.warn(`[QBWC] Unknown method: ${method}`);
        responseXml = soapEnvelope('');
    }
  } catch (err: any) {
    console.error(`[QBWC] Error handling ${method}:`, err);
    responseXml = soapEnvelope(`
      <tns:getLastErrorResponse>
        <tns:getLastErrorResult>Server error: ${escapeXmlForSoap(err.message)}</tns:getLastErrorResult>
      </tns:getLastErrorResponse>`);
  }

  res.set('Content-Type', 'text/xml; charset=utf-8');
  res.send(responseXml);
});

// ---------------------------------------------------------------------------
// WSDL endpoint — QBWC fetches this on setup
// ---------------------------------------------------------------------------

qbwcRouter.get('/soap', (req: Request, res: Response) => {
  // When QBWC does a GET on the SOAP URL, serve the WSDL
  // Also handle ?wsdl query parameter
  try {
    // Resolve WSDL path relative to this file (src/routes/qbwc.ts → src/services/qbwc.wsdl)
    // At runtime via tsx, __dirname = actual src path. In compiled dist, one level up to services/
    const wsdlPath = join(__dirname, '..', 'services', 'qbwc.wsdl');
    let wsdl = readFileSync(wsdlPath, 'utf-8');

    // Replace the placeholder URL with the actual server URL
    const protocol = (req.query.proto as string) || req.headers['x-forwarded-proto'] as string || req.protocol || 'http';
    const host = (req.query.host as string) || req.headers['x-forwarded-host'] as string || req.headers.host || 'localhost:3001';
    const actualUrl = `${protocol}://${host}/api/qbwc/soap`;
    wsdl = wsdl.replace('https://REPLACE_WITH_YOUR_URL/api/qbwc/soap', actualUrl);

    res.set('Content-Type', 'text/xml; charset=utf-8');
    res.send(wsdl);
  } catch (err: any) {
    console.error('[QBWC] Error serving WSDL:', err);
    res.status(500).send('Error serving WSDL');
  }
});

// ---------------------------------------------------------------------------
// QWC file download — give this to the person installing QBWC
// ---------------------------------------------------------------------------

qbwcRouter.get('/qwc', (req: Request, res: Response) => {
  // ?host= is not optional in practice. The Web Connector refuses a plain
  // http:// AppURL unless the host looks like `localhost`; anything else needs
  // https:// with a certificate the QB machine trusts. Rather than issue one,
  // prod maps `localhost2` to this API in the QB host's hosts file and uses
  // http://localhost2:3001 — the name passes the check while resolving to
  // another machine. A second instance needs its own name (see SANDBOX.md).
  //
  // Whatever req.headers.host says is almost never right either: generating the
  // file from a browser on the server gives 127.0.0.1, which on the QB machine
  // means the QB machine.
  //
  // ?proto=https override if behind a reverse proxy
  const protocol = (req.query.proto as string) || req.headers['x-forwarded-proto'] as string || req.protocol || 'http';
  const host = (req.query.host as string) || req.headers['x-forwarded-host'] as string || req.headers.host || 'localhost:3001';
  const soapUrl = `${protocol}://${host}/api/qbwc/soap`;

  const qwc = `<?xml version="1.0"?>
<QBWCXML>
  <AppName>${escapeXmlForSoap(QBWC_APP_NAME)}</AppName>
  <AppID></AppID>
  <AppURL>${soapUrl}</AppURL>
  <AppDescription>Service Pro field service platform — pushes Sales Orders to QuickBooks</AppDescription>
  <AppSupport>${protocol}://${host}</AppSupport>
  <UserName>${QBWC_USERNAME}</UserName>
  <OwnerID>${QBWC_OWNER_ID}</OwnerID>
  <FileID>${QBWC_FILE_ID}</FileID>
  <QBType>QBFS</QBType>${QBWC_RUN_EVERY_N_MINUTES > 0 ? `
  <Scheduler>
    <RunEveryNMinutes>${QBWC_RUN_EVERY_N_MINUTES}</RunEveryNMinutes>
  </Scheduler>` : ''}
  <IsReadOnly>false</IsReadOnly>
</QBWCXML>`;

  res.set('Content-Type', 'application/xml');
  const fileSlug = QBWC_APP_NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'sundog-qbwc';
  res.set('Content-Disposition', `attachment; filename="${fileSlug}.qwc"`);
  res.send(qwc);
});

// ---------------------------------------------------------------------------
// Cert download — so the QB machine can install the self-signed cert
// ---------------------------------------------------------------------------

qbwcRouter.get('/cert', (_req: Request, res: Response) => {
  try {
    const certPath = join(__dirname, '..', 'certs', 'server.crt');
    const cert = readFileSync(certPath);
    res.set('Content-Type', 'application/x-x509-ca-cert');
    res.set('Content-Disposition', 'attachment; filename="servicepro-qbwc.crt"');
    res.send(cert);
  } catch {
    res.status(404).send('No cert file found');
  }
});

// ---------------------------------------------------------------------------
// Diagnostic endpoint — hit this from a browser to test QBWC readiness
// ---------------------------------------------------------------------------

qbwcRouter.get('/test', ...qbAdminGuard, async (req: Request, res: Response) => {
  const results: Record<string, any> = {};

  // 1. Which QuickBooks this instance talks to. First thing to check when a
  //     sandbox and prod share a QBWC host — they must not match here.
  results.identity = {
    appName: QBWC_APP_NAME,
    fileId: QBWC_FILE_ID,
    ownerId: QBWC_OWNER_ID,
    companyFile: QBWC_COMPANY_FILE || '(whichever file is open in QuickBooks)',
    companyFilePinned: QBWC_COMPANY_FILE.length > 0,
    enabled: QBWC_ENABLED,
    autoRun: QBWC_RUN_EVERY_N_MINUTES > 0
      ? `every ${QBWC_RUN_EVERY_N_MINUTES} min`
      : 'manual only (no scheduler in the .qwc)',
  };

  // 2. Check credentials — presence only, never echo any part of the secret
  results.credentials = {
    username: QBWC_USERNAME,
    passwordSet: QBWC_PASSWORD.length > 0,
  };

  // 2. Check queue state
  const queueStats = await prisma.qbSyncQueue.groupBy({
    by: ['status'],
    _count: true,
  });
  results.queue = {
    byStatus: Object.fromEntries(queueStats.map(s => [s.status, s._count])),
  };

  // 3. Check for stuck 'sent' items
  const STUCK_TIMEOUT_MS = 5 * 60 * 1000;
  const stuckCutoff = new Date(Date.now() - STUCK_TIMEOUT_MS);
  const stuckSent = await prisma.qbSyncQueue.count({
    where: { status: 'sent', sentAt: { lt: stuckCutoff } },
  });
  results.queue.stuckSentItems = stuckSent;

  // 4. Peek at pending items
  const pending = await prisma.qbSyncQueue.findMany({
    where: { status: 'pending', retryCount: { lt: MAX_RETRIES } },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    take: 5,
    select: { id: true, entityType: true, action: true, entityId: true, status: true, retryCount: true, createdAt: true, sentAt: true },
  });
  results.queue.pendingPreview = pending;

  // 5. Check SSL cert
  const certPath = join(__dirname, '..', 'certs', 'server.crt');
  const keyPath = join(__dirname, '..', 'certs', 'server.key');
  results.ssl = {
    certExists: existsSync(certPath),
    keyExists: existsSync(keyPath),
    httpsPort: process.env.HTTPS_PORT || 3443,
  };

  // 6. Generate the URL that QBWC should be pointing to
  const protocol = req.headers['x-forwarded-proto'] as string || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] as string || req.headers.host || 'localhost:3001';
  results.urls = {
    soapUrl: `${protocol}://${host}/api/qbwc/soap`,
    soapUrlHttps: `https://${host.replace(/:\d+$/, '')}:${process.env.HTTPS_PORT || 3443}/api/qbwc/soap`,
    qwcDownload: `${protocol}://${host}/api/qbwc/qwc`,
    wsdl: `${protocol}://${host}/api/qbwc/soap?wsdl`,
  };

  // 7. Simulate authenticate step
  if (pending.length > 0) {
    results.simulate = {
      authenticateResult: 'Would return ticket + work (items pending)',
      nextItem: pending[0],
    };
    // Try building qbXML for the first pending item to test for errors
    try {
      const qbxml = await buildQbxmlForEntry(pending[0]);
      results.simulate.qbxmlPreview = qbxml.substring(0, 500) + (qbxml.length > 500 ? '...' : '');
      results.simulate.qbxmlLength = qbxml.length;
      results.simulate.buildResult = 'OK';
    } catch (err: any) {
      results.simulate.buildResult = `ERROR: ${err.message}`;
    }
  } else {
    results.simulate = {
      authenticateResult: 'Would return "none" (nothing pending)',
      hint: 'Queue some invoices via Push to QB button first',
    };
  }

  // 8. Active sessions
  results.activeSessions = sessions.size;

  res.json(results);
});

// ---------------------------------------------------------------------------
// POST /test-soap — Simulate a real QBWC SOAP call to test body parsing
// ---------------------------------------------------------------------------

qbwcRouter.post('/test-soap', ...qbAdminGuard, async (req: Request, res: Response) => {
  // This tests if the express.text middleware is working correctly
  const body = typeof req.body === 'string' ? req.body : null;
  const contentType = req.headers['content-type'] || 'unknown';
  res.json({
    bodyReceived: body !== null,
    bodyType: typeof req.body,
    bodyLength: body?.length || 0,
    bodyPreview: body?.substring(0, 300) || String(req.body)?.substring(0, 300),
    contentType,
    headers: {
      soapAction: req.headers['soapaction'] || 'not set',
      contentType,
    },
  });
});

