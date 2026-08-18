import { resolve } from "node:path";

/**
 * Environment configuration for JiveDrive. All variables use the
 * `JIVEDRIVE_` prefix; `NODE_ENV` is read unprefixed.
 */
export interface S3Config {
  /** OVHcloud Object Storage S3 endpoint URL, e.g. https://s3.gra.io.cloud.ovh.net. */
  endpoint: string;
  /** OVHcloud region, e.g. "gra". */
  region: string;
  /** S3 access key id. */
  accessKeyId: string;
  /** S3 secret access key. */
  secretAccessKey: string;
}

/** Bootstrap admin account provisioned at startup (optional). */
export interface BootstrapAdminConfig {
  username: string | null;
  bucket: string | null;
  /** Normalised prefix, always ending with "/", possibly empty. */
  prefix: string;
  /** Whether the bootstrap account is created as an admin (default true). */
  isAdmin: boolean;
  /**
   * Secret token gating first-passkey enrollment for the bootstrap admin,
   * or null when no bootstrap admin is configured. Required when
   * {@link username} is set and at least 16 characters; the length rule is
   * enforced whenever the token is provided, even without a username.
   */
  enrollmentToken: string | null;
}

/** WebAuthn relying party settings. */
export interface WebAuthnConfig {
  /** Relying party ID, e.g. "drive.grimes.id.au" or "localhost". */
  rpId: string;
  /** Relying party origin, e.g. "https://drive.grimes.id.au". */
  origin: string;
}

/** The validated application configuration. */
export interface AppConfig {
  nodeEnv: "development" | "production" | "test";
  port: number;
  /** Path to the SQLite database file. */
  dbPath: string;
  /** Directory containing ordered .sql migration files. */
  migrationsDir: string;
  /** Session lifetime in days. */
  sessionTtlDays: number;
  /** Session idle timeout in days (rolling lastUsedAt clock). */
  sessionIdleDays: number;
  /** Per-client-identity rate limits by route family. */
  rateLimit: {
    /** Maximum requests per minute for /auth/*. */
    authPerMinute: number;
    /** Token-bucket burst capacity for /auth/*. */
    authBurst: number;
    /** Maximum requests per minute for /api/files/*. */
    filesPerMinute: number;
    /** Token-bucket burst capacity for /api/files/*. */
    filesBurst: number;
    /**
     * When true, client identity comes from the leftmost X-Forwarded-For
     * value (deployments behind a reverse proxy); when false, the socket
     * remote address is used and X-Forwarded-For is ignored.
     */
    trustProxy: boolean;
  };
  s3: S3Config;
  bootstrapAdmin: BootstrapAdminConfig;
  webauthn: WebAuthnConfig;
}

/** Normalise a storage prefix: no leading slash, exactly one trailing slash. */
function normalizePrefix(
  prefix: string | undefined,
  errors: string[],
  label: string,
): string {
  const value = prefix ?? "";
  if (value === "") return "";
  if (value.startsWith("/")) {
    errors.push(`${label} must not have a leading "/"`);
    return "";
  }
  return value.replace(/\/+$/, "") + "/";
}

/** Parse a positive integer, pushing an error for the given label when invalid. */
function parseIntPositive(
  raw: string | undefined,
  label: string,
  errors: string[],
): number | null {
  if (raw === undefined || raw === "") {
    errors.push(`${label} must be set`);
    return null;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    errors.push(`${label} must be a positive integer, got "${raw}"`);
    return null;
  }
  return value;
}

/**
 * Parse and validate the application configuration from environment variables.
 *
 * Required variables: `JIVEDRIVE_S3_ENDPOINT`, `JIVEDRIVE_S3_ACCESS_KEY_ID`,
 * `JIVEDRIVE_S3_SECRET_ACCESS_KEY`. In production `NODE_ENV=production`,
 * `JIVEDRIVE_WEBAUTHN_RP_ID` and `JIVEDRIVE_WEBAUTHN_ORIGIN` (https) are
 * also required. `JIVEDRIVE_BOOTSTRAP_ADMIN_ENROLLMENT_TOKEN` is required
 * whenever `JIVEDRIVE_BOOTSTRAP_ADMIN_USERNAME` is set.
 *
 * @param env - environment variable map, defaults to `process.env`
 * @returns the validated configuration
 * @throws {Error} when any required variable is missing or invalid; the
 *   message lists every problem found
 * @example
 * ```ts
 * const config = loadConfig(process.env);
 * ```
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  const errors: string[] = [];

  const nodeEnv = env.NODE_ENV ?? "development";
  if (!["development", "production", "test"].includes(nodeEnv)) {
    errors.push(
      `NODE_ENV must be one of development, production, test, got "${nodeEnv}"`,
    );
  }

  const port = parseIntPositive(
    env.JIVEDRIVE_PORT ?? "3000",
    "JIVEDRIVE_PORT",
    errors,
  );
  if (port !== null && (port < 1 || port > 65535)) {
    errors.push(
      `JIVEDRIVE_PORT must be between 1 and 65535, got "${env.JIVEDRIVE_PORT}"`,
    );
  }

  const sessionTtlDays = parseIntPositive(
    env.JIVEDRIVE_SESSION_TTL_DAYS ?? "30",
    "JIVEDRIVE_SESSION_TTL_DAYS",
    errors,
  );

  const sessionIdleDays = parseIntPositive(
    env.JIVEDRIVE_SESSION_IDLE_DAYS ?? "7",
    "JIVEDRIVE_SESSION_IDLE_DAYS",
    errors,
  );

  const authPerMinute = parseIntPositive(
    env.JIVEDRIVE_RATE_LIMIT_AUTH_PER_MINUTE ?? "20",
    "JIVEDRIVE_RATE_LIMIT_AUTH_PER_MINUTE",
    errors,
  );
  const authBurst = parseIntPositive(
    env.JIVEDRIVE_RATE_LIMIT_AUTH_BURST ?? "10",
    "JIVEDRIVE_RATE_LIMIT_AUTH_BURST",
    errors,
  );
  const filesPerMinute = parseIntPositive(
    env.JIVEDRIVE_RATE_LIMIT_FILES_PER_MINUTE ?? "300",
    "JIVEDRIVE_RATE_LIMIT_FILES_PER_MINUTE",
    errors,
  );
  const filesBurst = parseIntPositive(
    env.JIVEDRIVE_RATE_LIMIT_FILES_BURST ?? "100",
    "JIVEDRIVE_RATE_LIMIT_FILES_BURST",
    errors,
  );

  let trustProxy = false;
  const rawTrustProxy = env.JIVEDRIVE_TRUST_PROXY ?? "false";
  if (rawTrustProxy === "true") trustProxy = true;
  else if (rawTrustProxy === "false") trustProxy = false;
  else {
    errors.push(
      'JIVEDRIVE_TRUST_PROXY must be "true" or "false", got "' +
        rawTrustProxy +
        '"',
    );
  }

  const s3Endpoint = env.JIVEDRIVE_S3_ENDPOINT;
  if (!s3Endpoint) {
    errors.push("JIVEDRIVE_S3_ENDPOINT must be set");
  } else {
    try {
      const url = new URL(s3Endpoint);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        errors.push(
          `JIVEDRIVE_S3_ENDPOINT must be an http(s) URL, got "${s3Endpoint}"`,
        );
      }
    } catch {
      errors.push(
        `JIVEDRIVE_S3_ENDPOINT must be a valid URL, got "${s3Endpoint}"`,
      );
    }
  }

  if (!env.JIVEDRIVE_S3_ACCESS_KEY_ID) {
    errors.push("JIVEDRIVE_S3_ACCESS_KEY_ID must be set");
  }
  if (!env.JIVEDRIVE_S3_SECRET_ACCESS_KEY) {
    errors.push("JIVEDRIVE_S3_SECRET_ACCESS_KEY must be set");
  }

  const bootstrapUsername = env.JIVEDRIVE_BOOTSTRAP_ADMIN_USERNAME ?? null;
  let bootstrapBucket: string | null = null;
  if (bootstrapUsername !== null) {
    if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(bootstrapUsername)) {
      errors.push(
        "JIVEDRIVE_BOOTSTRAP_ADMIN_USERNAME must match [a-z0-9][a-z0-9._-]{0,31}",
      );
    }
    bootstrapBucket = env.JIVEDRIVE_BOOTSTRAP_ADMIN_BUCKET ?? null;
    if (
      !bootstrapBucket ||
      !/^(?!.*\.\.)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bootstrapBucket)
    ) {
      errors.push(
        "JIVEDRIVE_BOOTSTRAP_ADMIN_BUCKET must be set to a valid S3 bucket name when a bootstrap admin is configured",
      );
    }
  }
  const bootstrapPrefix = normalizePrefix(
    env.JIVEDRIVE_BOOTSTRAP_ADMIN_PREFIX,
    errors,
    "JIVEDRIVE_BOOTSTRAP_ADMIN_PREFIX",
  );

  let bootstrapIsAdmin = true;
  if (bootstrapUsername !== null) {
    const rawIsAdmin = env.JIVEDRIVE_BOOTSTRAP_ADMIN_IS_ADMIN ?? "true";
    if (rawIsAdmin === "true") bootstrapIsAdmin = true;
    else if (rawIsAdmin === "false") bootstrapIsAdmin = false;
    else {
      errors.push(
        'JIVEDRIVE_BOOTSTRAP_ADMIN_IS_ADMIN must be "true" or "false", got "' +
          rawIsAdmin +
          '"',
      );
    }
  }

  // The enrollment token gates the bootstrap admin's first passkey. It is
  // required exactly when a bootstrap admin is configured, and (chosen
  // contract) its 16-character minimum is enforced whenever it is provided,
  // even without a username — a deliberately short value is always a mistake.
  const bootstrapEnrollmentToken =
    env.JIVEDRIVE_BOOTSTRAP_ADMIN_ENROLLMENT_TOKEN ?? null;
  if (bootstrapUsername !== null && bootstrapEnrollmentToken === null) {
    errors.push(
      "JIVEDRIVE_BOOTSTRAP_ADMIN_ENROLLMENT_TOKEN must be set when JIVEDRIVE_BOOTSTRAP_ADMIN_USERNAME is set",
    );
  }
  if (
    bootstrapEnrollmentToken !== null &&
    bootstrapEnrollmentToken.length < 16
  ) {
    errors.push(
      "JIVEDRIVE_BOOTSTRAP_ADMIN_ENROLLMENT_TOKEN must be at least 16 characters long",
    );
  }

  const isProduction = nodeEnv === "production";
  const rpId = env.JIVEDRIVE_WEBAUTHN_RP_ID;
  const origin = env.JIVEDRIVE_WEBAUTHN_ORIGIN;
  if (isProduction) {
    if (!rpId)
      errors.push("JIVEDRIVE_WEBAUTHN_RP_ID must be set in production");
    if (!origin) {
      errors.push("JIVEDRIVE_WEBAUTHN_ORIGIN must be set in production");
    } else {
      try {
        const url = new URL(origin);
        if (url.protocol !== "https:") {
          errors.push(
            `JIVEDRIVE_WEBAUTHN_ORIGIN must use https in production, got "${origin}"`,
          );
        }
      } catch {
        errors.push(
          `JIVEDRIVE_WEBAUTHN_ORIGIN must be a valid URL, got "${origin}"`,
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n- ${errors.join("\n- ")}`);
  }

  return {
    nodeEnv: nodeEnv as AppConfig["nodeEnv"],
    port: port as number,
    dbPath: env.JIVEDRIVE_DB_PATH ?? "jivedrive.db",
    migrationsDir:
      env.JIVEDRIVE_MIGRATIONS_DIR ?? resolve(process.cwd(), "migrations"),
    sessionTtlDays: sessionTtlDays as number,
    sessionIdleDays: sessionIdleDays as number,
    rateLimit: {
      authPerMinute: authPerMinute as number,
      authBurst: authBurst as number,
      filesPerMinute: filesPerMinute as number,
      filesBurst: filesBurst as number,
      trustProxy,
    },
    s3: {
      endpoint: s3Endpoint as string,
      region: env.JIVEDRIVE_S3_REGION ?? "gra",
      accessKeyId: env.JIVEDRIVE_S3_ACCESS_KEY_ID as string,
      secretAccessKey: env.JIVEDRIVE_S3_SECRET_ACCESS_KEY as string,
    },
    bootstrapAdmin: {
      username: bootstrapUsername,
      bucket: bootstrapBucket,
      prefix: bootstrapPrefix,
      isAdmin: bootstrapIsAdmin,
      enrollmentToken: bootstrapEnrollmentToken,
    },
    webauthn: {
      rpId: rpId ?? "localhost",
      origin: origin ?? "http://localhost:5173",
    },
  };
}
