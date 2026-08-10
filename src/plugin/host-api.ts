/**
 * Re-exports of the OpenClaw plugin API types this plugin depends on.
 *
 * Centralised here so drift shows up in one place. All of these were checked
 * against the published `openclaw@2026.6.34` type definitions — note that is
 * BEHIND the repo's `main` (2026.8.1 at time of writing), so anything only
 * present on main must not be relied on.
 *
 * None of the APIs used here is trust-gated. Deliberately unused, because they
 * ARE gated to bundled/trusted-official plugins and we cannot qualify:
 * `runtime.state.openKeyedStore` and friends, `runtime.gateway`, and
 * `session.workflow.scheduleSessionTurn` (bundled-only).
 */
export type {
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  OpenClawPluginHttpRouteHandler,
} from "openclaw/plugin-sdk/plugin-entry";
