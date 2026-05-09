import { PostHog } from "posthog-node";
import os from "os";

let _client = null;

/**
 * Returns a shared PostHog client for this process.
 * Uses flushAt=1 / flushInterval=0 because the CLI is short-lived.
 * Call posthog().shutdown() at the end of main() to flush all queued events.
 */
export function posthog() {
  if (!_client) {
    _client = new PostHog(process.env.POSTHOG_API_KEY || "", {
      host: process.env.POSTHOG_HOST,
      flushAt: 1,
      flushInterval: 0,
      enableExceptionAutocapture: true,
    });
  }
  return _client;
}

/**
 * A stable distinct ID for this machine/user combo.
 * No personal data is sent unless the caller enriches events explicitly.
 */
export function getDistinctId() {
  const user = process.env.USER || process.env.USERNAME || "unknown";
  const host = os.hostname();
  return `amc-pipeline:${host}:${user}`;
}
