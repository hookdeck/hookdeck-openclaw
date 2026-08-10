import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import type { OpenClawPluginServiceContext } from "./host-api.js";
import type { HostSecretResolver } from "./secrets.js";

/** Where this plugin's config lives in the OpenClaw config tree. */
export const CONFIG_ROOT = "plugins.entries.hookdeck.config";

/**
 * Bridges to OpenClaw's secret-input runtime.
 *
 * Resolution happens per use rather than being cached: the built-in Webhooks
 * plugin was patched specifically to stop caching resolved secrets, so that
 * rotating one takes effect without restarting the Gateway. We inherit that.
 *
 * The host resolver needs the live `OpenClawConfig`, which only arrives with the
 * service context — hence `getConfig` rather than a captured value. When the
 * service has not started (or config is unavailable) we resolve nothing, and the
 * caller turns that into a retryable 503 so the event survives in Hookdeck.
 */
export function createHostSecretResolver(
  getConfig: () => OpenClawPluginServiceContext["config"] | undefined,
): HostSecretResolver {
  return async (value: unknown, relativePath: string) => {
    const config = getConfig();
    if (config === undefined) return { value: undefined, reason: "plugin not started" };

    const resolved = await resolveConfiguredSecretInputString({
      config,
      env: process.env,
      value,
      path: `${CONFIG_ROOT}.${relativePath}`,
    });

    return {
      value: resolved.value,
      ...(resolved.unresolvedRefReason ? { reason: resolved.unresolvedRefReason } : {}),
    };
  };
}
