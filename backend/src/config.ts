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
 * also required.
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
    },
    webauthn: {
      rpId: rpId ?? "localhost",
      origin: origin ?? "http://localhost:5173",
    },
  };
}
