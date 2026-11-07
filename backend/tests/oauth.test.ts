import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendQuery,
  bearerChallenge,
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
  generateOAuthToken,
  hashOAuthSecret,
  isAllowedRedirectUri,
  mcpResourceUrl,
  oauthIssuer,
  pkceS256Challenge,
  verifyPkceS256,
} from "../src/oauth";
import { config } from "./oauth-test-helpers";

describe("generateOAuthToken", () => {
  it("returns distinct 43-character base64url tokens (32 random bytes)", () => {
    const a = generateOAuthToken();
    const b = generateOAuthToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });
});

describe("hashOAuthSecret", () => {
  it("returns the lowercase SHA-256 hex digest", () => {
    expect(hashOAuthSecret("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("PKCE S256", () => {
  // RFC 7636 appendix B test vector.
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

  it("computes the RFC 7636 challenge", () => {
    expect(pkceS256Challenge(verifier)).toBe(challenge);
  });

  it("accepts the matching verifier", () => {
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
  });

  it("rejects a different verifier", () => {
    expect(verifyPkceS256(`${verifier.slice(0, -1)}Y`, challenge)).toBe(false);
  });

  it("rejects verifiers outside 43-128 unreserved characters", () => {
    const short = "a".repeat(42);
    expect(verifyPkceS256(short, pkceS256Challenge(short))).toBe(false);
    const long = "a".repeat(129);
    expect(verifyPkceS256(long, pkceS256Challenge(long))).toBe(false);
    const bad = `${"a".repeat(43)}!`;
    expect(verifyPkceS256(bad, pkceS256Challenge(bad))).toBe(false);
  });

  it("rejects a challenge of the wrong length without throwing", () => {
    expect(verifyPkceS256(verifier, "short")).toBe(false);
  });

  it("is plain base64url of SHA-256 (no plain method)", () => {
    const expected = createHash("sha256").update(verifier).digest("base64url");
    expect(pkceS256Challenge(verifier)).toBe(expected);
    expect(verifyPkceS256(verifier, verifier)).toBe(false);
  });
});

describe("isAllowedRedirectUri", () => {
  it("accepts absolute https URLs", () => {
    expect(
      isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback"),
    ).toBe(true);
    expect(isAllowedRedirectUri("https://example.com/cb?x=1")).toBe(true);
  });

  it("accepts http only on loopback hosts", () => {
    expect(isAllowedRedirectUri("http://localhost:6274/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:33418/")).toBe(true);
    expect(isAllowedRedirectUri("http://[::1]:8080/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://example.com/cb")).toBe(false);
    expect(isAllowedRedirectUri("http://localhost.evil.com/cb")).toBe(false);
  });

  it("rejects fragments, other schemes, relative and empty values", () => {
    expect(isAllowedRedirectUri("https://example.com/cb#frag")).toBe(false);
    expect(isAllowedRedirectUri("https://example.com/cb#")).toBe(false);
    expect(isAllowedRedirectUri("javascript:alert(1)")).toBe(false);
    expect(isAllowedRedirectUri("ftp://example.com/cb")).toBe(false);
    expect(isAllowedRedirectUri("/relative")).toBe(false);
    expect(isAllowedRedirectUri("")).toBe(false);
  });
});

describe("metadata", () => {
  it("derives the issuer and resource from the WebAuthn origin", () => {
    expect(oauthIssuer(config)).toBe("http://localhost:5173");
    expect(mcpResourceUrl(config)).toBe("http://localhost:5173/mcp");
    const trailing = {
      ...config,
      webauthn: { ...config.webauthn, origin: "https://drive.example/" },
    };
    expect(oauthIssuer(trailing)).toBe("https://drive.example");
  });

  it("builds RFC 9728 protected resource metadata", () => {
    expect(buildProtectedResourceMetadata(config)).toEqual({
      resource: "http://localhost:5173/mcp",
      authorization_servers: ["http://localhost:5173"],
      bearer_methods_supported: ["header"],
      scopes_supported: ["drive"],
      resource_name: "JiveDrive",
    });
  });

  it("builds RFC 8414 authorization server metadata", () => {
    const o = "http://localhost:5173";
    expect(buildAuthorizationServerMetadata(config)).toEqual({
      issuer: o,
      authorization_endpoint: `${o}/oauth/authorize`,
      token_endpoint: `${o}/oauth/token`,
      registration_endpoint: `${o}/oauth/register`,
      revocation_endpoint: `${o}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["drive"],
    });
  });

  it("builds the WWW-Authenticate challenge", () => {
    const base =
      'Bearer resource_metadata="http://localhost:5173/.well-known/oauth-protected-resource/mcp"';
    expect(bearerChallenge(config, false)).toBe(base);
    expect(bearerChallenge(config, true)).toBe(
      `${base}, error="invalid_token"`,
    );
  });
});

describe("appendQuery", () => {
  it("adds parameters, keeps existing query and skips null values", () => {
    expect(
      appendQuery("https://example.com/cb?x=1", {
        code: "a b",
        state: null,
        iss: "http://localhost:5173",
      }),
    ).toBe(
      "https://example.com/cb?x=1&code=a+b&iss=http%3A%2F%2Flocalhost%3A5173",
    );
  });
});
