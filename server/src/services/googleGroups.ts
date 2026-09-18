/**
 * Google Workspace Groups — reads group membership via Admin SDK Directory API.
 *
 * Requirements:
 *   1. A Google Cloud service account with domain-wide delegation
 *   2. Admin SDK Directory API enabled in the project
 *   3. Delegation scopes:
 *        https://www.googleapis.com/auth/admin.directory.group.readonly
 *        https://www.googleapis.com/auth/admin.directory.user.readonly
 *   4. Service account key JSON file path in GOOGLE_SA_KEY_PATH env var
 *   5. A Workspace admin email for impersonation in GOOGLE_ADMIN_EMAIL env var
 *
 * On login, we fetch the user's group memberships and match against the
 * GoogleRoleMapping table to determine their Sundog role.
 */

import { google } from 'googleapis';
import { prisma } from '../index.js';
import type { UserRole } from '../db.js';

let _authClient: any = null;

/**
 * Get (or create) an authenticated Admin SDK client.
 * Uses a service account with domain-wide delegation, impersonating
 * the admin email so we can read any user's group memberships.
 */
async function getAdminClient() {
  if (_authClient) return _authClient;

  const keyPath = process.env.GOOGLE_SA_KEY_PATH;
  const adminEmail = process.env.GOOGLE_ADMIN_EMAIL;

  if (!keyPath || !adminEmail) {
    return null; // Google Groups integration not configured
  }

  // Log diagnostic info on first call so admin can verify domain-wide delegation
  try {
    const fs = await import('fs');
    const keyData = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    console.log(`[googleGroups] Service account: ${keyData.client_email}`);
    console.log(`[googleGroups] Numeric client_id: ${keyData.client_id}`);
    console.log(`[googleGroups] ↑ This client_id must match Google Workspace Admin → Security → API Controls → Domain-wide Delegation`);
    console.log(`[googleGroups] Impersonating: ${adminEmail}`);
    console.log(`[googleGroups] Scope: https://www.googleapis.com/auth/admin.directory.group.readonly`);
  } catch (e) {
    console.warn(`[googleGroups] Could not read key file for diagnostics:`, e);
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: [
      'https://www.googleapis.com/auth/admin.directory.group.readonly',
      'https://www.googleapis.com/auth/admin.directory.user.readonly',
    ],
    clientOptions: {
      subject: adminEmail, // impersonate the admin
    },
  });

  try {
    _authClient = await auth.getClient();
  } catch (err) {
    console.error(`[googleGroups] Auth client creation failed:`, err instanceof Error ? err.message : err);
    console.error(`[googleGroups] TROUBLESHOOTING:`);
    console.error(`  1. Go to admin.google.com → Security → API Controls → Domain-wide Delegation`);
    console.error(`  2. Verify the Client ID above is listed there (not the email — the NUMERIC ID)`);
    console.error(`  3. Verify the scope is EXACTLY: https://www.googleapis.com/auth/admin.directory.group.readonly`);
    console.error(`  4. Go to console.cloud.google.com → APIs & Services → Library → "Admin SDK API" → must be ENABLED`);
    console.error(`  5. GOOGLE_ADMIN_EMAIL must be a Super Admin or have Directory API access`);
    throw err;
  }
  return _authClient;
}

/**
 * Fetch all Google Workspace groups that a user (by email) belongs to.
 * Returns an array of group email addresses (lowercased).
 *
 * Returns empty array if the Google Groups integration is not configured
 * or if the API call fails (graceful degradation).
 */
export async function getUserGroups(userEmail: string): Promise<string[]> {
  try {
    const authClient = await getAdminClient();
    if (!authClient) return [];

    const directory = google.admin({ version: 'directory_v1', auth: authClient });

    const response = await directory.groups.list({
      userKey: userEmail,
      domain: process.env.GOOGLE_ALLOWED_DOMAIN || undefined,
    });

    const groups = response.data.groups || [];
    return groups.map(g => (g.email || '').toLowerCase());
  } catch (err: any) {
    // Clear cached client on auth errors so config fixes take effect without restart
    if (err.message?.includes('unauthorized_client') || err.message?.includes('access_denied')) {
      _authClient = null;
    }
    console.warn(`[googleGroups] Failed to fetch groups for ${userEmail}:`, err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Given a list of group emails, resolve the Sundog role from the
 * GoogleRoleMapping table. If the user is in multiple mapped groups,
 * the one with the highest `priority` wins.
 *
 * Returns null if no mapping matches.
 */
export async function resolveRoleFromGroups(groupEmails: string[]): Promise<UserRole | null> {
  if (groupEmails.length === 0) return null;

  const mappings = await prisma.googleRoleMapping.findMany({
    where: {
      googleGroupEmail: { in: groupEmails },
      isActive: true,
    },
    orderBy: { priority: 'desc' },
  });

  if (mappings.length === 0) return null;

  // Highest priority mapping wins
  return mappings[0].sundogRole;
}

/**
 * Full pipeline: given a user email, fetch their Google groups and
 * resolve to a Sundog role. Returns null if unconfigured or no match.
 */
export async function resolveRoleForUser(userEmail: string): Promise<{
  role: UserRole | null;
  groups: string[];
}> {
  const groups = await getUserGroups(userEmail);
  const role = await resolveRoleFromGroups(groups);
  return { role, groups };
}

/**
 * Check if Google Groups integration is configured.
 */
export function isGoogleGroupsConfigured(): boolean {
  return !!(process.env.GOOGLE_SA_KEY_PATH && process.env.GOOGLE_ADMIN_EMAIL);
}

export interface WorkspaceUser {
  googleId: string;
  email: string;
  name: string;
  suspended: boolean;
  orgUnitPath: string | null;
}

/**
 * List all users in the Google Workspace domain via Directory API.
 * Paginates through results (500/page).
 */
export async function listWorkspaceUsers(domain?: string): Promise<WorkspaceUser[]> {
  const authClient = await getAdminClient();
  if (!authClient) return [];

  const directory = google.admin({ version: 'directory_v1', auth: authClient });
  const targetDomain = domain || process.env.GOOGLE_ALLOWED_DOMAIN;
  if (!targetDomain) {
    throw new Error('GOOGLE_ALLOWED_DOMAIN must be set to list workspace users');
  }

  const out: WorkspaceUser[] = [];
  let pageToken: string | undefined = undefined;
  do {
    const resp: any = await directory.users.list({
      domain: targetDomain,
      maxResults: 500,
      pageToken,
      orderBy: 'email',
    });
    const batch = resp.data.users || [];
    for (const u of batch) {
      out.push({
        googleId: String(u.id || ''),
        email: (u.primaryEmail || '').toLowerCase(),
        name: u.name?.fullName || u.name?.givenName || u.primaryEmail || '',
        suspended: !!u.suspended,
        orgUnitPath: u.orgUnitPath || null,
      });
    }
    pageToken = resp.data.nextPageToken || undefined;
  } while (pageToken);

  return out;
}

export interface SyncReport {
  created: number;
  updated: number;
  skippedSuspended: number;
  errors: { email: string; message: string }[];
  total: number;
}

/**
 * Pre-provision users from Google Workspace Directory.
 *
 * Behavior:
 *   - Suspended Google users → skipped entirely (existing Sundog users left alone).
 *   - Active Google users with a group→role mapping → created/updated as active.
 *   - Active Google users with NO group mapping → created/updated as isActive=false
 *     (visible in admin UI but cannot log in until a mapping is added).
 *   - Matches by email. Sets authProviderId from Google id.
 *   - Never overwrites an existing user's PIN, passwordHash, name (if already set by a human).
 */
export async function syncWorkspaceUsers(): Promise<SyncReport> {
  const wsUsers = await listWorkspaceUsers();
  const report: SyncReport = {
    created: 0,
    updated: 0,
    skippedSuspended: 0,
    errors: [],
    total: wsUsers.length,
  };

  for (const wu of wsUsers) {
    if (wu.suspended) {
      report.skippedSuspended++;
      continue;
    }
    try {
      const { role } = await resolveRoleForUser(wu.email);
      const existing = await prisma.user.findUnique({ where: { email: wu.email } });

      if (existing) {
        const updateData: any = {
          authProviderId: wu.googleId || existing.authProviderId,
        };
        // Only set name if user has no custom name yet (keep human edits)
        if (!existing.name || existing.name === existing.email) {
          updateData.name = wu.name;
        }
        // If a role mapping exists, apply it. If not, leave existing role alone.
        if (role) {
          updateData.role = role;
          // Reactivate a user who was auto-deactivated from a prior no-mapping sync
          if (!existing.isActive && !existing.passwordHash && !existing.pinHash) {
            updateData.isActive = true;
          }
        }
        await prisma.user.update({ where: { id: existing.id }, data: updateData });
        report.updated++;
      } else {
        await prisma.user.create({
          data: {
            email: wu.email,
            name: wu.name,
            role: role || 'field_tech', // placeholder; isActive=false blocks login
            isActive: !!role,
            authProviderId: wu.googleId || null,
          },
        });
        report.created++;
      }
    } catch (err: any) {
      report.errors.push({ email: wu.email, message: err?.message || 'unknown error' });
    }
  }

  return report;
}
