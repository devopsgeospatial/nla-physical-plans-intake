import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Stateless, encrypted (AES-256-GCM) cookies. The ArcGIS tokens never reach browser JavaScript:
 * cookies are httpOnly and the payload is opaque without SESSION_SECRET.
 */

export const SESSION_COOKIE = "pp_session";
export const OAUTH_STATE_COOKIE = "pp_oauth";

export interface UserSession {
  username: string;
  fullName: string;
  accessToken: string;
  /** epoch ms */
  accessExpiresAt: number;
  refreshToken: string;
  /** epoch ms */
  refreshExpiresAt: number;
  /** Signed in to the review app (checked at sign-in against the reviewer group). */
  reviewer?: boolean;
}

export interface OAuthState {
  state: string;
  codeVerifier: string;
  returnTo: string;
}

export function seal(value: unknown, secret: string): string {
  const key = deriveKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

/** Returns null for missing, tampered, or undecryptable values (e.g. after rotating SESSION_SECRET). */
export function unseal<T>(sealed: string | undefined, secret: string): T | null {
  if (!sealed) return null;
  try {
    const raw = Buffer.from(sealed, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const json = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

/**
 * The signed-in user, or null. A session only works in the app it was issued by: a planner's cookie
 * is never accepted by the review app (and the reverse), even when both share SESSION_SECRET.
 */
export function readSession(sealed: string | undefined, config: { sessionSecret: string; appMode: string }): UserSession | null {
  const session = unseal<UserSession>(sealed, config.sessionSecret);
  if (!session || session.refreshExpiresAt <= Date.now()) return null;
  if (config.appMode !== "submission" && config.appMode !== "review") return null; // the landing page and public viewer have no sign-in
  if (!!session.reviewer !== (config.appMode === "review")) return null;
  return session;
}

export function sessionCookieOptions(session: UserSession) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    expires: new Date(session.refreshExpiresAt),
  };
}

function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}
