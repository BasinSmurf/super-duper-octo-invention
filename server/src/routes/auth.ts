import express, { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { prisma } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';
import { authenticate, type AuthPayload } from '../middleware/auth.js';
import { resolveRoleForUser, isGoogleGroupsConfigured } from '../services/googleGroups.js';
import { getReportSubscriptions, saveReportPreference } from '../services/reportSubscriptions.js';

export const authRouter = Router();

const googleClient = new OAuth2Client();

function issueToken(user: { id: string; email: string; role: string }): string {
  const payload: AuthPayload = {
    userId: user.id,
    email: user.email,
    role: user.role,
  };
  return jwt.sign(payload, process.env.JWT_SECRET!, {
    expiresIn: 86400, // 24 hours in seconds
  });
}

async function userResponse(user: { id: string; email: string; name: string; role: string; companyId?: string | null; homeSiteId?: string | null; pinHash?: string | null }) {
  const help = await startHelpTips(user.id);
  return { ...help, id: user.id, email: user.email, name: user.name, role: user.role, companyId: user.companyId ?? null, homeSiteId: user.homeSiteId ?? null, hasPin: !!user.pinHash };
}

// Set once on first authenticated use, including for existing accounts.
async function startHelpTips(userId: string) {
  await prisma.user.updateMany({
    where: { id: userId, helpTipsStartedAt: null },
    data: { helpTipsStartedAt: new Date() },
  });
  return prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { helpTipsStartedAt: true, helpTipsEnabled: true },
  });
}

/**
 * Verify a Google ID token, enforce the Workspace domain, resolve the role from
 * group membership, and match-or-create the user. Shared by the JSON endpoint
 * (POST /google, popup/client-callback flow) and the redirect callback below.
 */
async function resolveGoogleUser(idToken: string) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new AppError(500, 'Google OAuth not configured');

  const ticket = await googleClient.verifyIdToken({ idToken, audience: clientId });
  const googlePayload = ticket.getPayload();
  if (!googlePayload || !googlePayload.email) throw new AppError(401, 'Invalid Google token');

  const allowedDomain = process.env.GOOGLE_ALLOWED_DOMAIN;
  if (allowedDomain && googlePayload.hd !== allowedDomain) {
    throw new AppError(403, `Only ${allowedDomain} accounts are allowed`);
  }
  if (!googlePayload.email_verified) throw new AppError(401, 'Email not verified by Google');

  const email = googlePayload.email.toLowerCase();
  const displayName = googlePayload.name || email.split('@')[0];

  let user = await prisma.user.findUnique({ where: { email } });
  if (user && !user.isActive) throw new AppError(403, 'Account is deactivated');

  let resolvedRole: string | null = null;
  if (isGoogleGroupsConfigured()) {
    const result = await resolveRoleForUser(email);
    resolvedRole = result.role;
    console.log(`[auth/google] ${email} groups: [${result.groups.join(', ')}] → role: ${resolvedRole || 'none'}`);
  }

  if (user) {
    const updateData: any = { authProviderId: googlePayload.sub, lastLoginAt: new Date() };
    if (resolvedRole) updateData.role = resolvedRole;
    user = await prisma.user.update({ where: { id: user.id }, data: updateData });
  } else {
    if (!resolvedRole) {
      throw new AppError(403,
        'No Service Pro account found and no matching group membership. ' +
        'Ask your admin to add you to a Service Pro group in Google Workspace.');
    }
    user = await prisma.user.create({
      data: { email, name: displayName, role: resolvedRole as any, authProviderId: googlePayload.sub, lastLoginAt: new Date() },
    });
    console.log(`[auth/google] Auto-created user ${email} with role ${resolvedRole}`);
  }
  return user;
}

// POST /api/auth/login — email + password login
authRouter.post('/login', async (req: Request, res: Response, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      throw new AppError(400, 'Email and password required');
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive) {
      throw new AppError(401, 'Invalid credentials');
    }
    if (!user.passwordHash) {
      throw new AppError(401, 'Password login not configured for this user');
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      throw new AppError(401, 'Invalid credentials');
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    res.json({ token: issueToken(user), user: await userResponse(user) });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/pin — PIN login (field iPads)
authRouter.post('/pin', async (req: Request, res: Response, next) => {
  try {
    const { email, pin } = req.body;
    if (!email || !pin) {
      throw new AppError(400, 'Email and PIN required');
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive) {
      throw new AppError(401, 'Invalid credentials');
    }
    if (!user.pinHash) {
      throw new AppError(401, 'PIN login not configured for this user');
    }

    const valid = await bcrypt.compare(pin, user.pinHash);
    if (!valid) {
      throw new AppError(401, 'Invalid PIN');
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    res.json({ token: issueToken(user), user: await userResponse(user) });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/google — Google Workspace SSO
// Client sends the Google ID token from Sign In With Google button.
// We verify it, check the domain, look up group memberships, and match/create the user.
authRouter.post('/google', async (req: Request, res: Response, next) => {
  try {
    const { idToken } = req.body;
    if (!idToken) {
      throw new AppError(400, 'idToken required');
    }

    const user = await resolveGoogleUser(idToken);
    res.json({ token: issueToken(user), user: await userResponse(user) });
  } catch (err) {
    // Google auth library throws generic errors — wrap them
    if (err instanceof AppError) {
      next(err);
    } else {
      next(new AppError(401, 'Google authentication failed'));
    }
  }
});

// Read a single cookie value off the raw header (no cookie-parser mounted).
function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

// Embed a value safely inside an inline <script> in the bounce page.
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

// POST /api/auth/google/callback — Google Identity Services *redirect* mode.
// Unlike POST /google (popup, client-side callback), Google navigates the whole
// tab here and form-POSTs the credential, so it survives "block all popups".
// We verify it, mint our JWT, and return a tiny page that seeds localStorage
// (the app's Bearer store) and bounces to the app — a server redirect can't
// write localStorage, hence the HTML shim.
authRouter.post('/google/callback', express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
  const fail = (msg: string) => res.redirect(302, `/login?authError=${encodeURIComponent(msg)}`);
  try {
    // Double-submit CSRF check per Google's redirect-mode contract.
    const bodyToken = (req.body?.g_csrf_token as string) || '';
    const cookieToken = readCookie(req, 'g_csrf_token') || '';
    if (!bodyToken || !cookieToken || bodyToken !== cookieToken) {
      return fail('Sign-in could not be verified. Please try again.');
    }

    const credential = req.body?.credential as string | undefined;
    if (!credential) return fail('No Google credential received.');

    const user = await resolveGoogleUser(credential);
    const token = issueToken(user);

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html><meta charset="utf-8"><title>Signing in…</title>
<body style="font-family:system-ui;background:#f8fafc;color:#475569;display:flex;height:100vh;align-items:center;justify-content:center;margin:0">
<p>Signing you in…</p>
<script>
try {
  localStorage.setItem('sundog_token', ${jsonForScript(token)});
  localStorage.setItem('sundog_user', ${jsonForScript(JSON.stringify(await userResponse(user)))});
} catch (e) {}
location.replace('/');
</script></body>`);
  } catch (err) {
    fail(err instanceof AppError ? err.message : 'Google authentication failed');
  }
});

// PUT /api/auth/pin — the signed-in user sets/changes their OWN PIN. (Admin PIN
// management lives on /api/users/:id/pin, platform_admin only.)
authRouter.put('/pin', authenticate, async (req: Request, res: Response, next) => {
  try {
    const pinStr = String(req.body?.pin ?? '').trim();
    if (!/^\d{4,6}$/.test(pinStr)) throw new AppError(400, 'PIN must be 4-6 digits');

    const saltRounds = parseInt(process.env.PIN_SALT_ROUNDS || '10', 10);
    const pinHash = await bcrypt.hash(pinStr, saltRounds);
    await prisma.user.update({ where: { id: req.user!.userId }, data: { pinHash } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// PUT /api/auth/me/password — the signed-in user sets/changes their OWN local
// password. For staff this is a Google failover password; for portal customers
// this is their self-serve password reset path. Separate from Google's own
// password; never touches the Workspace credential.
const MIN_PASSWORD_LENGTH = 12;
authRouter.put('/me/password', authenticate, async (req: Request, res: Response, next) => {
  try {
    const password = req.body?.password;
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      throw new AppError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    const saltRounds = parseInt(process.env.PASSWORD_SALT_ROUNDS || '12', 10);
    const passwordHash = await bcrypt.hash(password, saltRounds);
    await prisma.user.update({ where: { id: req.user!.userId }, data: { passwordHash } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

const NOTIFY_CADENCES = ['immediate', 'daily', 'weekly', 'off'] as const;

authRouter.get('/me/reports', authenticate, async (req, res) => {
  res.json(await getReportSubscriptions(prisma, req.user!.userId));
});
authRouter.put('/me/reports/:type', authenticate, async (req, res) => {
  await saveReportPreference(prisma, req.user!.userId, req.user!.userId, req.params.type, req.body?.cadence);
  res.json(await getReportSubscriptions(prisma, req.user!.userId));
});

// PUT /api/auth/me/notifications — the signed-in user sets their own email
// notification cadence. Stored as JSON (User.notificationPrefs), same pattern
// as dashboardWidgets — only a single "default" category exists today; this
// shape leaves room for per-category prefs once alert categories exist.
authRouter.put('/me/notifications', authenticate, async (req: Request, res: Response, next) => {
  try {
    const cadence = req.body?.cadence;
    if (!NOTIFY_CADENCES.includes(cadence)) {
      throw new AppError(400, `cadence must be one of: ${NOTIFY_CADENCES.join(', ')}`);
    }
    const notificationPrefs = { default: { channel: 'email', cadence } };
    await prisma.$executeRaw`UPDATE users SET notification_prefs = COALESCE(notification_prefs, '{}'::jsonb) || ${JSON.stringify(notificationPrefs)}::jsonb, updated_at = NOW() WHERE id = ${req.user!.userId}`;
    res.json({ ok: true, notificationPrefs });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me — current user info
// null restores the automatic 90-day policy; a boolean overrides it.
authRouter.put('/me/help-tips', authenticate, async (req: Request, res: Response, next) => {
  try {
    const enabled = req.body?.enabled;
    if (enabled !== null && typeof enabled !== 'boolean') {
      throw new AppError(400, 'enabled must be true, false, or null');
    }
    const user = await prisma.user.update({
      where: { id: req.user!.userId },
      data: { helpTipsEnabled: enabled },
      select: { helpTipsStartedAt: true, helpTipsEnabled: true },
    });
    res.json(user);
  } catch (err) { next(err); }
});

// GET /api/auth/me - current user info
authRouter.get('/me', authenticate, async (req: Request, res: Response, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        role: true,
        companyId: true,
        homeSiteId: true,
        isActive: true,
        lastLoginAt: true,
        lastSyncAt: true,
        pinHash: true,
        passwordHash: true,
        notificationPrefs: true,
      },
    });
    if (!user) throw new AppError(404, 'User not found');
    const { pinHash, passwordHash, ...rest } = user;
    const help = await startHelpTips(user.id);
    res.json({ ...rest, ...help, hasPin: !!pinHash, hasPassword: !!passwordHash });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/config — public config for the login screen
authRouter.get('/config', (_req: Request, res: Response) => {
  res.json({
    googleClientId: process.env.GOOGLE_CLIENT_ID || null,
    googleEnabled: !!process.env.GOOGLE_CLIENT_ID,
    googleGroupsEnabled: isGoogleGroupsConfigured(),
    pinEnabled: true,
    passwordEnabled: true,
  });
});
