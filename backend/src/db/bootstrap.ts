/**
 * Provision the bootstrap admin account from configuration at startup
 * (T028).
 */
import type { Database } from "bun:sqlite";
import type { BootstrapAdminConfig } from "../config";
import { createUser, getUserByUsername } from "./repository";
import type { User } from "./repository";

/**
 * Create the bootstrap admin when configured and the username is not
 * already taken. Does nothing otherwise.
 *
 * The account is created with the configured admin flag (default true).
 *
 * @param db - database connection
 * @param config - bootstrap admin configuration
 * @returns the created user, or null when nothing was provisioned
 * @throws {Error} when a username is configured without a bucket
 */
export function bootstrapAdmin(
  db: Database,
  config: BootstrapAdminConfig,
): User | null {
  if (config.username === null) return null;
  if (getUserByUsername(db, config.username)) return null;
  if (config.bucket === null) {
    throw new Error(
      "Bootstrap admin bucket must be set when a username is configured",
    );
  }
  return createUser(db, {
    username: config.username,
    bucket: config.bucket,
    prefix: config.prefix,
    isAdmin: config.isAdmin,
  });
}
