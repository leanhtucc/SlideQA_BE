import { OAuth2Client } from "google-auth-library";
import { env } from "../../config/env.js";

export interface GoogleIdentity {
  /** Mã người dùng Google, ổn định và duy nhất */
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

export type GoogleVerifier = (credential: string) => Promise<GoogleIdentity>;

const client = new OAuth2Client();

/** Xác thực ID token do Google ký: chữ ký, hạn dùng, issuer và đúng client ID của ứng dụng này (aud). */
const verifyWithGoogle: GoogleVerifier = async (credential) => {
  const ticket = await client.verifyIdToken({ idToken: credential, audience: env.GOOGLE_CLIENT_ID! });
  const p = ticket.getPayload();
  if (!p?.sub || !p.email) throw new Error("ID token thiếu sub hoặc email");
  return { sub: p.sub, email: p.email.toLowerCase(), emailVerified: p.email_verified === true, name: p.name ?? null };
};

let verifier: GoogleVerifier = verifyWithGoogle;
/** Chỉ cho test: thay bộ xác thực để không gọi Google thật. */
export const setGoogleVerifierForTests = (v: GoogleVerifier | null) => {
  verifier = v ?? verifyWithGoogle;
};
export const verifyGoogleToken: GoogleVerifier = (c) => verifier(c);
