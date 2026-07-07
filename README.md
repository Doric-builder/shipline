# shipline

**Deploy only the Firebase functions your change actually affects.**

One functions codebase means `firebase deploy --only functions` redeploys *all* of them on
any change — slow, and heavy projects trip the Cloud Functions write-ops quota. shipline
builds each function's transitive require-closure from source and deploys only the functions
whose closure includes a changed file. On the project this was extracted from: a typical
domain edit went from **83 functions to 4–14**.

```
npm install -g shipline

shipline affected --since HEAD~1          # what would deploy?
shipline deploy --project my-staging --staged
shipline watch                            # fail-closed staging auto-deploy
```

Zero dependencies. Requires a barrel-style `functions/index.js`
(`exports.name = require("./domains/x").name;`) — the pattern you want anyway.

## Never under-deploys — safe by design

A targeted deploy updates only the named functions; everything else keeps its last-deployed
code. So the resolver must be *provably* complete, and it falls back to a FULL deploy
whenever it can't prove safety:

- `index.js` / `package.json` / lockfile / `.env` changed → full
- a changed source file that no function's closure reaches → full
- a shared file reaching ≥60% of functions → full (cleaner than 50 `--only` flags)
- `index.js` unparsable → full

Inline exports in index.js (no `require` delegation) can't be statically scoped — they ride
along on every targeted deploy and get reported, so you know to move them into a module.

## The watcher (`shipline watch`)

A polling staging auto-deployer with every guard we learned the hard way:

- **Fail-closed config** — the project id is explicit (never a remappable alias), must exist
  in `.firebaserc`, must not be in `forbidProjects` (production stays promote-only), and the
  repo path must not match `forbidPathPatterns` (deploying from a OneDrive/Dropbox-synced
  copy is a corruption vector).
- **Hooks that can't ship stale artifacts** — a `preDeploy` hook (your bundler) that FAILS
  never lets its target deploy; only a successful hook earns the deploy. Hook outputs get
  their mtimes adopted so the watcher's own writes don't re-trigger it forever. We once
  shipped a stale bundle under a green log; this rule is why you won't.
- **Failure backoff with a loud record** — retries back off 30s → 5min instead of hammering
  on the save-debounce, and 3+ consecutive failures append a LOUD line to
  `.deploy-state/deploy-log.txt`. We once lost an hour to deploys silently not landing,
  one terse scrollback line per cycle. Scrollback is not a record.
- **Fingerprint skip** — functions source is hashed (lockfile included, node_modules
  excluded); an unchanged hash skips the multi-minute functions build on watcher startup.
  The marker is written only after a successful FULL deploy.
- **The 429 fix** — `GOOGLE_CLOUD_QUOTA_PROJECT` is set to *your* project. firebase-tools
  bills its cloudbilling pre-check to a shared internal project whose global quota is
  saturated (firebase-tools#9895) — the reason functions deploys 429 while hosting sails
  through. Enable the Cloud Billing API on your project once, and the 429s stop.

Config: see [`example/shipline.config.json`](example/shipline.config.json).

## CI usage

```yaml
- run: npx shipline deploy --project my-staging --since ${{ github.event.before }}
```

`shipline affected --since <ref>` prints the JSON verdict + the exact `firebase deploy`
command, so you can wire it into anything.

## Honest scope

CommonJS `require`-closure analysis only (ESM functions codebases: PRs welcome, the
resolver is one module). Polling watcher by design — editor-agnostic, works where fs-events
don't. Single-codebase Firebase projects; if you use functions codebases already, you have
a different solution. Maintenance is best-effort; issues with a failing test reproduction
get attention first.

## Where this comes from

Extracted from the deploy line behind [Doric](https://doric.build) — every guard in the
watcher is a production incident we only had to have once. The write-up:
[doric.build/blog/shipline](https://doric.build/blog/shipline).

Sibling packages: [keepline](https://github.com/Doric-builder/keepline) (context integrity
for LLM sessions) · [wireline](https://github.com/Doric-builder/wireline) (find code that is
built but never wired) · [plotline](https://github.com/Doric-builder/plotline) (the
context-integrity benchmark).

MIT © Gabriel Kerner
