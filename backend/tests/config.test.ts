import { describe, expect, it } from "bun:test";
import { loadConfig } from "../src/config";

/**
 * A minimal valid environment: only the required S3 credentials are set.
 * Everything else must fall back to defaults.
 */
const minimalEnv: Record<string, string | undefined> = {
  JIVEDRIVE_S3_ENDPOINT: "https://s3.gra.io.cloud.ovh.net",
  JIVEDRIVE_S3_ACCESS_KEY_ID: "AKIAEXAMPLE123",
  JIVEDRIVE_S3_SECRET_ACCESS_KEY: "s3cr3t",
};

describe("loadConfig", () => {
  it("applies defaults for every optional variable", () => {
    const config = loadConfig(minimalEnv);

    expect(config.nodeEnv).toBe("development");
    expect(config.port).toBe(3000);
    expect(config.dbPath).toBe("jivedrive.db");
    expect(config.sessionIdleDays).toBe(7);
    expect(config.searchScanIntervalSeconds).toBe(3600);
    expect(config.searchIndexMaxBytes).toBe(10485760);
    expect(config.rateLimit).toEqual({
      authPerMinute: 20,
      authBurst: 10,
      filesPerMinute: 300,
      filesBurst: 100,
      shareLinksPerMinute: 60,
      shareLinksBurst: 30,
      trustProxy: false,
    });
    expect(config.s3.endpoint).toBe("https://s3.gra.io.cloud.ovh.net");
    expect(config.s3.region).toBe("gra");
    expect(config.s3.accessKeyId).toBe("AKIAEXAMPLE123");
    expect(config.s3.secretAccessKey).toBe("s3cr3t");
    expect(config.bootstrapAdmin).toEqual({
      username: null,
      bucket: null,
      prefix: "",
      isAdmin: true,
      enrollmentToken: null,
    });
    expect(config.webauthn.rpId).toBe("localhost");
    expect(config.webauthn.origin).toBe("http://localhost:5173");
  });

  it("parses numeric and string overrides from the environment", () => {
    const config = loadConfig({
      ...minimalEnv,
      JIVEDRIVE_PORT: "8080",
      JIVEDRIVE_SESSION_TTL_DAYS: "7",
      JIVEDRIVE_DB_PATH: "/var/lib/jivedrive/jivedrive.db",
      JIVEDRIVE_S3_REGION: "sbg",
      NODE_ENV: "production",
      JIVEDRIVE_WEBAUTHN_RP_ID: "drive.grimes.id.au",
      JIVEDRIVE_WEBAUTHN_ORIGIN: "https://drive.grimes.id.au",
    });

    expect(config.port).toBe(8080);
    expect(config.sessionTtlDays).toBe(7);
    expect(config.dbPath).toBe("/var/lib/jivedrive/jivedrive.db");
    expect(config.s3.region).toBe("sbg");
    expect(config.nodeEnv).toBe("production");
  });

  it("parses the bootstrap admin configuration and normalises its prefix", () => {
    const config = loadConfig({
      ...minimalEnv,
      JIVEDRIVE_BOOTSTRAP_ADMIN_USERNAME: "admin",
      JIVEDRIVE_BOOTSTRAP_ADMIN_BUCKET: "jivedrive-prod",
      JIVEDRIVE_BOOTSTRAP_ADMIN_PREFIX: "users/admin",
      JIVEDRIVE_BOOTSTRAP_ADMIN_ENROLLMENT_TOKEN: "0123456789abcdef",
    });

    expect(config.bootstrapAdmin).toEqual({
      username: "admin",
      bucket: "jivedrive-prod",
      prefix: "users/admin/",
      isAdmin: true,
      enrollmentToken: "0123456789abcdef",
    });
  });

  it("defaults the bootstrap admin flag to true", () => {
    const config = loadConfig({
      ...minimalEnv,
      JIVEDRIVE_BOOTSTRAP_ADMIN_USERNAME: "admin",
      JIVEDRIVE_BOOTSTRAP_ADMIN_BUCKET: "jivedrive-prod",
      JIVEDRIVE_BOOTSTRAP_ADMIN_ENROLLMENT_TOKEN: "0123456789abcdef",
    });

    expect(config.bootstrapAdmin.isAdmin).toBe(true);
  });

  it("parses an explicit bootstrap admin flag", () => {
    const config = loadConfig({
      ...minimalEnv,
      JIVEDRIVE_BOOTSTRAP_ADMIN_USERNAME: "admin",
      JIVEDRIVE_BOOTSTRAP_ADMIN_BUCKET: "jivedrive-prod",
      JIVEDRIVE_BOOTSTRAP_ADMIN_IS_ADMIN: "false",
      JIVEDRIVE_BOOTSTRAP_ADMIN_ENROLLMENT_TOKEN: "0123456789abcdef",
    });

    expect(config.bootstrapAdmin.isAdmin).toBe(false);
  });

  it("rejects an invalid bootstrap admin flag", () => {
    expect(() =>
      loadConfig({
        ...minimalEnv,
        JIVEDRIVE_BOOTSTRAP_ADMIN_USERNAME: "admin",
        JIVEDRIVE_BOOTSTRAP_ADMIN_BUCKET: "jivedrive-prod",
        JIVEDRIVE_BOOTSTRAP_ADMIN_IS_ADMIN: "yes",
      }),
    ).toThrow(/JIVEDRIVE_BOOTSTRAP_ADMIN_IS_ADMIN/);
  });

  it("allows an empty bootstrap admin prefix for the bucket root", () => {
    const config = loadConfig({
      ...minimalEnv,
      JIVEDRIVE_BOOTSTRAP_ADMIN_USERNAME: "admin",
      JIVEDRIVE_BOOTSTRAP_ADMIN_BUCKET: "jivedrive-prod",
      JIVEDRIVE_BOOTSTRAP_ADMIN_ENROLLMENT_TOKEN: "0123456789abcdef",
    });

    expect(config.bootstrapAdmin.prefix).toBe("");
  });

  it("parses WebAuthn relying party configuration", () => {
    const config = loadConfig({
      ...minimalEnv,
      JIVEDRIVE_WEBAUTHN_RP_ID: "drive.grimes.id.au",
      JIVEDRIVE_WEBAUTHN_ORIGIN: "https://drive.grimes.id.au",
    });

    expect(config.webauthn.rpId).toBe("drive.grimes.id.au");
    expect(config.webauthn.origin).toBe("https://drive.grimes.id.au");
  });

  it("rejects a missing S3 endpoint", () => {
    const env = { ...minimalEnv };
    delete env.JIVEDRIVE_S3_ENDPOINT;

    expect(() => loadConfig(env)).toThrow(/JIVEDRIVE_S3_ENDPOINT/);
  });

  it("rejects a missing S3 access key", () => {
    const env = { ...minimalEnv };
    delete env.JIVEDRIVE_S3_ACCESS_KEY_ID;

    expect(() => loadConfig(env)).toThrow(/JIVEDRIVE_S3_ACCESS_KEY_ID/);
  });

  it("rejects a missing S3 secret access key", () => {
    const env = { ...minimalEnv };
    delete env.JIVEDRIVE_S3_SECRET_ACCESS_KEY;

    expect(() => loadConfig(env)).toThrow(/JIVEDRIVE_S3_SECRET_ACCESS_KEY/);
  });

  it("lists every validation problem in one error", () => {
    expect(() => loadConfig({})).toThrow(/JIVEDRIVE_S3_ENDPOINT/);
    expect(() => loadConfig({})).toThrow(/JIVEDRIVE_S3_ACCESS_KEY_ID/);
    expect(() => loadConfig({})).toThrow(/JIVEDRIVE_S3_SECRET_ACCESS_KEY/);
  });

  it("rejects a non-URL S3 endpoint", () => {
    expect(() =>
      loadConfig({ ...minimalEnv, JIVEDRIVE_S3_ENDPOINT: "not a url" }),
    ).toThrow(/JIVEDRIVE_S3_ENDPOINT/);
  });

  it("rejects an invalid port", () => {
    for (const value of ["abc", "0", "-1", "70000", "1.5"]) {
      expect(() =>
        loadConfig({ ...minimalEnv, JIVEDRIVE_PORT: value }),
      ).toThrow(/JIVEDRIVE_PORT/);
    }
  });

  it("rejects an invalid session TTL", () => {
    for (const value of ["abc", "0", "-7"]) {
      expect(() =>
        loadConfig({ ...minimalEnv, JIVEDRIVE_SESSION_TTL_DAYS: value }),
      ).toThrow(/JIVEDRIVE_SESSION_TTL_DAYS/);
    }
  });

  it("parses the session idle days with a default of 7 (T002)", () => {
    expect(loadConfig(minimalEnv).sessionIdleDays).toBe(7);
    expect(
      loadConfig({ ...minimalEnv, JIVEDRIVE_SESSION_IDLE_DAYS: "14" })
        .sessionIdleDays,
    ).toBe(14);
  });

  it("rejects an invalid session idle days value (T002)", () => {
    for (const value of ["abc", "0", "-7", "1.5"]) {
      expect(() =>
        loadConfig({ ...minimalEnv, JIVEDRIVE_SESSION_IDLE_DAYS: value }),
      ).toThrow(/JIVEDRIVE_SESSION_IDLE_DAYS/);
    }
  });

  it("parses rate-limit overrides and the trust proxy flag (T002)", () => {
    const config = loadConfig({
      ...minimalEnv,
      JIVEDRIVE_RATE_LIMIT_AUTH_PER_MINUTE: "40",
      JIVEDRIVE_RATE_LIMIT_AUTH_BURST: "25",
      JIVEDRIVE_RATE_LIMIT_FILES_PER_MINUTE: "600",
      JIVEDRIVE_RATE_LIMIT_FILES_BURST: "200",
      JIVEDRIVE_RATE_LIMIT_SHARE_LINKS_PER_MINUTE: "120",
      JIVEDRIVE_RATE_LIMIT_SHARE_LINKS_BURST: "50",
      JIVEDRIVE_TRUST_PROXY: "true",
    });

    expect(config.rateLimit).toEqual({
      authPerMinute: 40,
      authBurst: 25,
      filesPerMinute: 600,
      filesBurst: 200,
      shareLinksPerMinute: 120,
      shareLinksBurst: 50,
      trustProxy: true,
    });
  });

  it("rejects invalid rate-limit values (T002)", () => {
    for (const key of [
      "JIVEDRIVE_RATE_LIMIT_AUTH_PER_MINUTE",
      "JIVEDRIVE_RATE_LIMIT_AUTH_BURST",
      "JIVEDRIVE_RATE_LIMIT_FILES_PER_MINUTE",
      "JIVEDRIVE_RATE_LIMIT_SHARE_LINKS_PER_MINUTE",
      "JIVEDRIVE_RATE_LIMIT_SHARE_LINKS_BURST",
    ]) {
      for (const value of ["abc", "0", "-5", "2.5"]) {
        expect(() => loadConfig({ ...minimalEnv, [key]: value })).toThrow(
          new RegExp(key),
        );
      }
    }
  });

  it("rejects an invalid trust proxy value (T002)", () => {
    for (const value of ["yes", "1", "TRUE", ""]) {
      expect(() =>
        loadConfig({ ...minimalEnv, JIVEDRIVE_TRUST_PROXY: value }),
      ).toThrow(/JIVEDRIVE_TRUST_PROXY/);
    }
  });

  it("parses the search scan interval with a default of 3600 seconds (T002)", () => {
    expect(loadConfig(minimalEnv).searchScanIntervalSeconds).toBe(3600);
    expect(
      loadConfig({
        ...minimalEnv,
        JIVEDRIVE_SEARCH_SCAN_INTERVAL_SECONDS: "60",
      }).searchScanIntervalSeconds,
    ).toBe(60);
  });

  it("rejects an invalid search scan interval (T002)", () => {
    for (const value of ["abc", "0", "-1", "1.5"]) {
      expect(() =>
        loadConfig({
          ...minimalEnv,
          JIVEDRIVE_SEARCH_SCAN_INTERVAL_SECONDS: value,
        }),
      ).toThrow(/JIVEDRIVE_SEARCH_SCAN_INTERVAL_SECONDS/);
    }
  });

  it("parses the search index size cap with a default of 10 MiB (T002)", () => {
    expect(loadConfig(minimalEnv).searchIndexMaxBytes).toBe(10485760);
    expect(
      loadConfig({ ...minimalEnv, JIVEDRIVE_SEARCH_INDEX_MAX_BYTES: "5242880" })
        .searchIndexMaxBytes,
    ).toBe(5242880);
  });

  it("rejects an invalid search index size cap (T002)", () => {
    for (const value of ["abc", "0", "-1", "1.5"]) {
      expect(() =>
        loadConfig({ ...minimalEnv, JIVEDRIVE_SEARCH_INDEX_MAX_BYTES: value }),
      ).toThrow(/JIVEDRIVE_SEARCH_INDEX_MAX_BYTES/);
    }
  });

  it("rejects a bootstrap admin without a bucket", () => {
    expect(() =>
      loadConfig({
        ...minimalEnv,
        JIVEDRIVE_BOOTSTRAP_ADMIN_USERNAME: "admin",
      }),
    ).toThrow(/JIVEDRIVE_BOOTSTRAP_ADMIN_BUCKET/);
  });

  it("requires an enrollment token when a bootstrap admin is configured (T002)", () => {
    expect(() =>
      loadConfig({
        ...minimalEnv,
        JIVEDRIVE_BOOTSTRAP_ADMIN_USERNAME: "admin",
        JIVEDRIVE_BOOTSTRAP_ADMIN_BUCKET: "jivedrive-prod",
      }),
    ).toThrow(/JIVEDRIVE_BOOTSTRAP_ADMIN_ENROLLMENT_TOKEN/);
  });

  it("rejects an enrollment token shorter than 16 characters (T002)", () => {
    for (const value of ["", "short", "123456789012345"]) {
      expect(() =>
        loadConfig({
          ...minimalEnv,
          JIVEDRIVE_BOOTSTRAP_ADMIN_USERNAME: "admin",
          JIVEDRIVE_BOOTSTRAP_ADMIN_BUCKET: "jivedrive-prod",
          JIVEDRIVE_BOOTSTRAP_ADMIN_ENROLLMENT_TOKEN: value,
        }),
      ).toThrow(/JIVEDRIVE_BOOTSTRAP_ADMIN_ENROLLMENT_TOKEN/);
    }
  });

  it("accepts an enrollment token of at least 16 characters (T002)", () => {
    const config = loadConfig({
      ...minimalEnv,
      JIVEDRIVE_BOOTSTRAP_ADMIN_USERNAME: "admin",
      JIVEDRIVE_BOOTSTRAP_ADMIN_BUCKET: "jivedrive-prod",
      JIVEDRIVE_BOOTSTRAP_ADMIN_ENROLLMENT_TOKEN: "0123456789abcdef",
    });
    expect(config.bootstrapAdmin.enrollmentToken).toBe("0123456789abcdef");
  });

  it("still validates an enrollment token length without a bootstrap username (T002)", () => {
    // Chosen contract: the length rule applies whenever the token is
    // provided, even when no bootstrap admin is configured.
    expect(() =>
      loadConfig({
        ...minimalEnv,
        JIVEDRIVE_BOOTSTRAP_ADMIN_ENROLLMENT_TOKEN: "short",
      }),
    ).toThrow(/JIVEDRIVE_BOOTSTRAP_ADMIN_ENROLLMENT_TOKEN/);

    const config = loadConfig({
      ...minimalEnv,
      JIVEDRIVE_BOOTSTRAP_ADMIN_ENROLLMENT_TOKEN: "0123456789abcdef",
    });
    expect(config.bootstrapAdmin.enrollmentToken).toBe("0123456789abcdef");
    expect(config.bootstrapAdmin.username).toBeNull();
  });

  it("rejects a bootstrap prefix with a leading slash", () => {
    expect(() =>
      loadConfig({
        ...minimalEnv,
        JIVEDRIVE_BOOTSTRAP_ADMIN_USERNAME: "admin",
        JIVEDRIVE_BOOTSTRAP_ADMIN_BUCKET: "jivedrive-prod",
        JIVEDRIVE_BOOTSTRAP_ADMIN_PREFIX: "/users/admin/",
      }),
    ).toThrow(/JIVEDRIVE_BOOTSTRAP_ADMIN_PREFIX/);
  });

  it("rejects a bootstrap prefix containing a .. segment (T053)", () => {
    expect(() =>
      loadConfig({
        ...minimalEnv,
        JIVEDRIVE_BOOTSTRAP_ADMIN_USERNAME: "admin",
        JIVEDRIVE_BOOTSTRAP_ADMIN_BUCKET: "jivedrive-prod",
        JIVEDRIVE_BOOTSTRAP_ADMIN_PREFIX: "users/../bob/",
        JIVEDRIVE_BOOTSTRAP_ADMIN_ENROLLMENT_TOKEN: "0123456789abcdef",
      }),
    ).toThrow(/JIVEDRIVE_BOOTSTRAP_ADMIN_PREFIX/);
  });

  it("accepts a bootstrap prefix with two dots inside a segment (T053)", () => {
    const config = loadConfig({
      ...minimalEnv,
      JIVEDRIVE_BOOTSTRAP_ADMIN_USERNAME: "admin",
      JIVEDRIVE_BOOTSTRAP_ADMIN_BUCKET: "jivedrive-prod",
      JIVEDRIVE_BOOTSTRAP_ADMIN_PREFIX: "users/a..b",
      JIVEDRIVE_BOOTSTRAP_ADMIN_ENROLLMENT_TOKEN: "0123456789abcdef",
    });
    expect(config.bootstrapAdmin.prefix).toBe("users/a..b/");
  });

  it("requires WebAuthn RP ID and origin in production", () => {
    expect(() => loadConfig({ ...minimalEnv, NODE_ENV: "production" })).toThrow(
      /JIVEDRIVE_WEBAUTHN_RP_ID/,
    );
    expect(() => loadConfig({ ...minimalEnv, NODE_ENV: "production" })).toThrow(
      /JIVEDRIVE_WEBAUTHN_ORIGIN/,
    );
  });

  it("rejects an insecure WebAuthn origin in production", () => {
    expect(() =>
      loadConfig({
        ...minimalEnv,
        NODE_ENV: "production",
        JIVEDRIVE_WEBAUTHN_RP_ID: "drive.grimes.id.au",
        JIVEDRIVE_WEBAUTHN_ORIGIN: "http://drive.grimes.id.au",
      }),
    ).toThrow(/JIVEDRIVE_WEBAUTHN_ORIGIN/);
  });
});
