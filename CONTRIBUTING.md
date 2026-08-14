# Contributing

## Running the tests

```bash
npm test                    # offline; no Gateway and no Hookdeck account
npm run typecheck
npm run test:package        # loads the packed tarball in a real Gateway
```

The offline suite drives the plugin against fakes. That is fast and
deterministic, and it is also why the live suites exist: a fake proves what the
plugin *sends*, never what Hookdeck does with it. Every serious defect found in
this repo passed a green offline suite.

### Live suites

These need a Hookdeck project. Put a project API key in `.env.local`:

```
HOOKDECK_TEST_API_KEY=...
```

```bash
npm run test:live               # the REST client against the real API
npm run test:e2e:verification   # provider verification, forged signatures included
npm run test:e2e:dispatch       # dispatch modes, filters, transports, version gate
npm run test:e2e                # the full path: tunnel, delivery, catch-up, recovery
npm run test:e2e:all            # all of the above
```

They create and delete real sources, destinations and connections, every one
prefixed `openclaw-`. **Point the key at a project used for nothing else.**
Teardown sweeps that prefix, including the names the plugin itself derives
(`openclaw-<routeId>`) rather than only the ones the harness chose — a lesson
from leaving a destination behind.

The `test:e2e` and `test:e2e:dispatch` suites also need the Hookdeck CLI (≥
2.4.0) with a logged-in session. Set `HOOKDECK_CLI_BIN` if yours is not at
`/usr/local/bin/hookdeck`; the absolute default is deliberate, because an npm
shim frequently shadows a newer Homebrew build on PATH.

## CI

| Workflow | When | What |
|---|---|---|
| `ci.yml` | every push and PR | workflow lint, formatting, types, the offline suite, and the packed artifact booted in a real Gateway |
| `integration.yml` | push to main, PR, manual | the live API suites; the tunnel suites on manual dispatch only |
| `publish.yml` | a published GitHub Release | npm publish with provenance |

`ci.yml` lints the workflows themselves with `actionlint`. An invalid workflow
file does not fail loudly — GitHub refuses to validate it and simply never runs
it, so a broken `publish.yml` looks exactly like a release that published
nothing. The publish workflow cannot check itself, so CI does it.

`integration.yml` skips rather than fails when `HOOKDECK_TEST_API_KEY` is
absent, so pull requests from forks — which cannot read secrets — stay green.

## Releasing

The tag is the version. `package.json` is not bumped in a commit, so there is
no release commit to land and no window where the two can disagree.

1. Get everything you want released onto `main`, green.
2. Publish a GitHub Release targeting `main`, tagged `vMAJOR.MINOR.PATCH`.

Publishing the release *is* the decision to ship; there is no second approval
step. The workflow checks out the tag, re-runs every gate, publishes to npm
with provenance, and attaches the exact tarball to the release.

A pre-release tag (`v0.2.0-beta.1`) publishes under the `beta` dist-tag, so
`npm install @hookdeck/openclaw` keeps resolving to the last stable version.

### npm setup, once

Publishing uses npm **trusted publishing** (OIDC), so there is no token in this
repository to leak or rotate. Trusted publishers are configured on an existing
package, so the very first version has to be published by hand to claim the
name; after that, configure the publisher on npmjs.com and every subsequent
version comes from CI.

Do not add an `NPM_TOKEN` secret. A credential in `.npmrc` takes precedence
over OIDC, so a half-configured or empty one silently becomes the publishing
identity — or fails.

### ClawHub

ClawHub is the plugin's primary distribution channel and is **not** automated.
The OpenClaw build in use ships no publishing command — `openclaw plugins` has
no publish path and there is no `clawhub` subcommand — so there is nothing to
drive from CI yet. Publish there by hand, and re-check `openclaw.compat.pluginApi`
in `package.json` against the current OpenClaw release first: a range that does
not match means the plugin is **silently skipped at discovery**, with only a
warning in the log.
