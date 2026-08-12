/**
 * Test helpers for crafting real WebAuthn registration and assertion
 * responses, used by the WebAuthn and auth route tests.
 *
 * Responses are built from a real ECDSA P-256 keypair and CBOR-encoded
 * attestation objects so they pass `@simplewebauthn/server` verification.
 */
import { createHash, generateKeyPairSync, sign as nodeSign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

/** A value that can be CBOR-encoded by {@link encodeCbor}. */
type CborValue = number | string | Uint8Array | Map<string | number, CborValue>;

/** A generated ECDSA P-256 keypair for crafting test responses. */
export interface TestKeyPair {
  /** COSE-encoded ECDSA P-256 public key (alg -7). */
  cosePublicKey: Uint8Array;
  /** Private key for signing assertions. */
  privateKey: KeyObject;
}

/** Options for {@link makeRegistrationResponse}. */
export interface RegistrationResponseOptions {
  challenge: string;
  origin: string;
  rpId: string;
  keyPair: TestKeyPair;
  /** Credential id bytes; defaults to a fixed 16-byte id. */
  credentialId?: Uint8Array;
  /** Authenticator sign count reported in authData. */
  counter?: number;
  transports?: AuthenticatorTransportFuture[];
}

/** Options for {@link makeAuthenticationResponse}. */
export interface AuthenticationResponseOptions {
  challenge: string;
  origin: string;
  rpId: string;
  keyPair: TestKeyPair;
  credentialId: Uint8Array;
  /** Authenticator sign count reported in authData. */
  counter: number;
  userHandle?: string;
}

/**
 * Encode a small CBOR structure: unsigned integers, text strings, byte
 * strings, negative integers and maps (enough for WebAuthn test vectors).
 *
 * @param value - value to encode
 * @returns the CBOR bytes
 */
function encodeCbor(value: CborValue): Uint8Array {
  const bytes: number[] = [];

  const encodeInt = (n: number): void => {
    if (n >= 0) {
      if (n < 24) bytes.push(n);
      else if (n < 256) bytes.push(0x18, n);
      else bytes.push(0x19, (n >> 8) & 0xff, n & 0xff);
    } else {
      const v = -1 - n;
      if (v < 24) bytes.push(0x20 + v);
      else bytes.push(0x38, v);
    }
  };

  const encodeValue = (v: CborValue): void => {
    if (typeof v === "number") {
      encodeInt(v);
    } else if (typeof v === "string") {
      const raw = [...Buffer.from(v, "utf8")];
      if (raw.length < 24) bytes.push(0x60 + raw.length);
      else bytes.push(0x78, raw.length);
      bytes.push(...raw);
    } else if (v instanceof Uint8Array) {
      if (v.length < 24) bytes.push(0x40 + v.length);
      else if (v.length < 256) bytes.push(0x58, v.length);
      else bytes.push(0x59, (v.length >> 8) & 0xff, v.length & 0xff);
      bytes.push(...v);
    } else {
      const entries = [...v.entries()];
      if (entries.length < 24) bytes.push(0xa0 + entries.length);
      else bytes.push(0xb8, entries.length);
      for (const [key, value] of entries) {
        encodeValue(key);
        encodeValue(value);
      }
    }
  };

  encodeValue(value);
  return Uint8Array.from(bytes);
}

/**
 * Base64url-encode a byte buffer.
 *
 * @param buffer - bytes to encode
 * @returns the base64url string
 */
function toBase64Url(buffer: Uint8Array): string {
  return Buffer.from(buffer).toString("base64url");
}

/**
 * @param rpId - relying party id
 * @returns the SHA-256 hash of the RP ID used in authenticator data
 */
function rpIdHash(rpId: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(rpId).digest());
}

/**
 * Generate an ECDSA P-256 keypair for crafting test responses.
 *
 * @returns the COSE public key and the private key
 */
export function makeKeyPair(): TestKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const jwk = publicKey.export({ format: "jwk" }) as {
    x: string;
    y: string;
  };
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");

  const cosePublicKey = encodeCbor(
    new Map<number, CborValue>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, x], // x coordinate
      [-3, y], // y coordinate
    ]),
  );

  return { cosePublicKey, privateKey };
}

/**
 * Craft a valid WebAuthn registration response ("none" attestation).
 *
 * @param options - challenge, origin, rpId and keypair
 * @returns a registration response ready for verification
 */
export function makeRegistrationResponse(
  options: RegistrationResponseOptions,
): RegistrationResponseJSON {
  const {
    challenge,
    origin,
    rpId,
    keyPair,
    credentialId = new Uint8Array(16).fill(0x42),
    counter = 0,
    transports = ["internal"],
  } = options;

  const clientDataJSON = Buffer.from(
    JSON.stringify({
      type: "webauthn.create",
      challenge,
      origin,
      crossOrigin: false,
    }),
  );

  // Authenticator data with attested credential data: rpIdHash, flags
  // (UP | UV | AT), sign count, aaguid, credential id, COSE public key.
  const flags = 0x45;
  const authData = new Uint8Array([
    ...rpIdHash(rpId),
    flags,
    ...Buffer.from([0, 0, 0, counter]),
    ...new Uint8Array(16), // aaguid, zero for "none" attestation
    ...Buffer.from([0, credentialId.length]),
    ...credentialId,
    ...keyPair.cosePublicKey,
  ]);

  const attestationObject = encodeCbor(
    new Map<string, CborValue>([
      ["fmt", "none"],
      ["attStmt", new Map()],
      ["authData", authData],
    ]),
  );

  return {
    id: toBase64Url(credentialId),
    rawId: toBase64Url(credentialId),
    response: {
      clientDataJSON: toBase64Url(clientDataJSON),
      attestationObject: toBase64Url(attestationObject),
      transports,
    },
    type: "public-key",
    clientExtensionResults: {},
  };
}

/**
 * Craft a valid WebAuthn assertion response signed with the keypair.
 *
 * @param options - challenge, origin, rpId, keypair and counter
 * @returns an assertion response ready for verification
 */
export function makeAuthenticationResponse(
  options: AuthenticationResponseOptions,
): AuthenticationResponseJSON {
  const {
    challenge,
    origin,
    rpId,
    keyPair,
    credentialId,
    counter,
    userHandle,
  } = options;

  const clientDataJSON = Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      challenge,
      origin,
      crossOrigin: false,
    }),
  );

  // Authenticator data without attested credential data.
  const flags = 0x05; // UP | UV
  const authenticatorData = new Uint8Array([
    ...rpIdHash(rpId),
    flags,
    ...Buffer.from([0, 0, 0, counter]),
  ]);

  const clientDataHash = createHash("sha256").update(clientDataJSON).digest();
  const signature = nodeSign(
    "sha256",
    Buffer.concat([Buffer.from(authenticatorData), clientDataHash]),
    keyPair.privateKey,
  );

  return {
    id: toBase64Url(credentialId),
    rawId: toBase64Url(credentialId),
    response: {
      clientDataJSON: toBase64Url(clientDataJSON),
      authenticatorData: toBase64Url(authenticatorData),
      signature: toBase64Url(signature),
      ...(userHandle ? { userHandle } : {}),
    },
    type: "public-key",
    clientExtensionResults: {},
  };
}
