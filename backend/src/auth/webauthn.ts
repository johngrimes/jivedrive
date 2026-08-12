/**
 * WebAuthn service wrapping `@simplewebauthn/server`: registration and
 * assertion options, response verification, credential conversion, and a
 * short-lived single-use challenge store.
 *
 * Challenges expire after 5 minutes and are consumed on use, so each
 * options response can only be completed once.
 */
import {
  generateAuthenticationOptions as swaGenerateAuthenticationOptions,
  generateRegistrationOptions as swaGenerateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  WebAuthnCredential,
} from "@simplewebauthn/server";
import type { PasskeyCredential } from "../db/repository";

/** A pending registration challenge bound to an invite token or username. */
export interface RegistrationChallengeRecord {
  /** Base64url challenge from the generated options. */
  challenge: string;
  /** Username the passkey will be registered for. */
  username: string;
  /** Invite token, or null when registering for an existing user. */
  inviteToken: string | null;
  /** Epoch milliseconds when the challenge was created. */
  createdAt: number;
}

/** A pending login challenge bound to a username. */
export interface LoginChallengeRecord {
  /** Base64url challenge from the generated options. */
  challenge: string;
  username: string;
  /** Epoch milliseconds when the challenge was created. */
  createdAt: number;
}

/** An in-memory single-use challenge store with expiry. */
export interface ChallengeStore {
  /**
   * Store a registration challenge under a key.
   *
   * @param key - invite token or username
   * @param record - the challenge record
   */
  putRegistration(key: string, record: RegistrationChallengeRecord): void;
  /**
   * Take and remove a registration challenge, or null when missing/expired.
   *
   * @param key - invite token or username
   * @param now - reference time in epoch ms, defaults to Date.now()
   * @returns the record, consumed
   */
  takeRegistration(
    key: string,
    now?: number,
  ): RegistrationChallengeRecord | null;
  /**
   * Store a login challenge under a username.
   *
   * @param key - username
   * @param record - the challenge record
   */
  putLogin(key: string, record: LoginChallengeRecord): void;
  /**
   * Take and remove a login challenge, or null when missing/expired.
   *
   * @param key - username
   * @param now - reference time in epoch ms, defaults to Date.now()
   * @returns the record, consumed
   */
  takeLogin(key: string, now?: number): LoginChallengeRecord | null;
  /**
   * Remove all expired challenges.
   *
   * @param now - reference time in epoch ms, defaults to Date.now()
   */
  sweep(now?: number): void;
  /** Number of stored challenges (for tests). */
  size(): number;
}

/** Options for {@link generateRegistrationOptions}. */
export interface RegistrationOptionsInput {
  rpId: string;
  /** User-visible relying party name. */
  rpName: string;
  username: string;
  /** Credentials already registered to the user, to exclude. */
  excludeCredentials?: { id: string; transports?: string[] }[];
}

/** A credential as it should be persisted after registration. */
export interface StoredCredentialData {
  /** WebAuthn credential id (base64url). */
  id: string;
  /** COSE-encoded public key as a base64url string. */
  publicKey: string;
  /** Signature counter from the authenticator. */
  counter: number;
  /** Transports reported by the browser. */
  transports: string[];
}

/** Options for {@link verifyRegistration}. */
export interface VerifyRegistrationInput {
  response: RegistrationResponseJSON;
  /** The challenge from the stored registration challenge record. */
  expectedChallenge: string;
  expectedOrigin: string;
  expectedRPID: string;
}

/** Options for {@link generateAuthenticationOptions}. */
export interface LoginOptionsInput {
  rpId: string;
  /** Credentials registered to the user. */
  allowCredentials: { id: string; transports?: string[] }[];
}

/** Options for {@link verifyLogin}. */
export interface VerifyLoginInput {
  response: AuthenticationResponseJSON;
  /** The challenge from the stored login challenge record. */
  expectedChallenge: string;
  expectedOrigin: string;
  expectedRPID: string;
  /** The stored credential matching the response's credential id. */
  credential: PasskeyCredential;
}

/** Default challenge lifetime in milliseconds (5 minutes). */
const DEFAULT_CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** User-visible relying party name shown in the passkey prompt. */
export const RP_NAME = "JiveDrive";

/**
 * Create a single-use challenge store with a fixed time-to-live.
 *
 * Challenges are keyed by kind plus token/username so registration and
 * login challenges never collide.
 *
 * @param ttlMs - challenge lifetime in ms, defaults to 5 minutes
 * @returns a new empty challenge store
 */
export function createChallengeStore(
  ttlMs = DEFAULT_CHALLENGE_TTL_MS,
): ChallengeStore {
  const entries = new Map<
    string,
    RegistrationChallengeRecord | LoginChallengeRecord
  >();

  const expired = (
    record: RegistrationChallengeRecord | LoginChallengeRecord,
    now: number,
  ): boolean => now - record.createdAt >= ttlMs;

  return {
    putRegistration(key, record) {
      entries.set(`reg:${key}`, record);
    },
    takeRegistration(key, now = Date.now()) {
      const record = entries.get(`reg:${key}`);
      if (!record || !("inviteToken" in record) || expired(record, now)) {
        entries.delete(`reg:${key}`);
        return null;
      }
      entries.delete(`reg:${key}`);
      return record;
    },
    putLogin(key, record) {
      entries.set(`login:${key}`, record);
    },
    takeLogin(key, now = Date.now()) {
      const record = entries.get(`login:${key}`);
      if (!record || "inviteToken" in record || expired(record, now)) {
        entries.delete(`login:${key}`);
        return null;
      }
      entries.delete(`login:${key}`);
      return record as LoginChallengeRecord;
    },
    sweep(now = Date.now()) {
      for (const [key, record] of entries) {
        if (expired(record, now)) entries.delete(key);
      }
    },
    size() {
      return entries.size;
    },
  };
}

/**
 * Generate PublicKeyCredentialCreationOptions for passkey registration.
 *
 * @param input - relying party, username and excluded credentials
 * @returns registration options for navigator.credentials.create()
 */
export async function generateRegistrationOptions(
  input: RegistrationOptionsInput,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return swaGenerateRegistrationOptions({
    rpName: input.rpName,
    rpID: input.rpId,
    userName: input.username,
    attestationType: "none",
    excludeCredentials: input.excludeCredentials?.map((credential) => ({
      id: credential.id,
      transports: credential.transports as AuthenticatorTransportFuture[],
    })),
  });
}

/**
 * Verify a registration response and return the data to persist.
 *
 * @param input - response and expected challenge/origin/rpId
 * @returns storable credential data
 * @throws {Error} when verification fails
 */
export async function verifyRegistration(
  input: VerifyRegistrationInput,
): Promise<StoredCredentialData> {
  const result = await verifyRegistrationResponse({
    response: input.response,
    expectedChallenge: input.expectedChallenge,
    expectedOrigin: input.expectedOrigin,
    expectedRPID: input.expectedRPID,
  });
  if (!result.verified) {
    throw new Error("Registration verification failed");
  }
  const credential = result.registrationInfo.credential;
  return {
    id: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString("base64url"),
    counter: credential.counter,
    transports: credential.transports ?? [],
  };
}

/**
 * Generate PublicKeyCredentialRequestOptions for passkey sign-in.
 *
 * @param input - relying party and the user's credentials
 * @returns assertion options for navigator.credentials.get()
 */
export async function generateAuthenticationOptions(
  input: LoginOptionsInput,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return swaGenerateAuthenticationOptions({
    rpID: input.rpId,
    allowCredentials: input.allowCredentials.map((credential) => ({
      id: credential.id,
      transports: credential.transports as AuthenticatorTransportFuture[],
    })),
  });
}

/**
 * Verify an assertion response and return the authenticator's new counter.
 *
 * @param input - response, expected challenge/origin/rpId and stored credential
 * @returns the new signature counter to persist
 * @throws {Error} when verification fails
 */
export async function verifyLogin(
  input: VerifyLoginInput,
): Promise<{ newCounter: number }> {
  const result = await verifyAuthenticationResponse({
    response: input.response,
    expectedChallenge: input.expectedChallenge,
    expectedOrigin: input.expectedOrigin,
    expectedRPID: input.expectedRPID,
    credential: toWebAuthnCredential(input.credential),
  });
  if (!result.verified) {
    throw new Error("Authentication verification failed");
  }
  // Some authenticators do not maintain a counter; persist whatever the
  // authenticator reported (simplewebauthn always returns a number).
  return { newCounter: result.authenticationInfo.newCounter };
}

/**
 * Convert a stored credential into the shape expected by simplewebauthn.
 *
 * The public key is stored base64url-encoded and must be decoded back into
 * bytes before verification.
 *
 * @param credential - stored credential with base64url public key
 * @returns a WebAuthnCredential for verification
 */
export function toWebAuthnCredential(
  credential: PasskeyCredential,
): WebAuthnCredential {
  return {
    id: credential.id,
    publicKey: new Uint8Array(Buffer.from(credential.publicKey, "base64url")),
    counter: credential.counter,
    transports: credential.transports as AuthenticatorTransportFuture[],
  };
}
