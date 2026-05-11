# Contributing to Lore

Thanks for your interest in contributing. This document covers the setup, conventions, and workflow for working on the codebase.

---

## Development setup

No build step, no package manager needed for the frontend.

```bash
git clone <repo>
cd lore

# Serve locally
python3 -m http.server 8080
# or
npx serve .
```

Open `http://localhost:8080`. The app is fully usable without a backend — all entity editing, the board, graph, structure, and saves work on `localStorage` alone.

### With backend

If you need cloud AI or auth:

1. Set up `infra/deploy.env` and `infra/backend.env` (see `.example` files)
2. Deploy the backend stack: `./infra/deploy-backend.sh`
3. Update `js/config.js` with the API Gateway URL and Cognito IDs from stack outputs
4. Log in at `http://localhost:8080` via Cognito

---

## Code conventions

**No framework, no bundler.** Lore is vanilla JS ES modules. Keep it that way — every new file is just a `.js` module.

**Module boundaries**

| Module | Responsibility |
|---|---|
| `store.js` | All data mutations and reads. Nothing else touches `localStorage` directly. |
| `app.js` | View routing, sidebar wiring, top-level event listeners. |
| `api.js` | All `fetch` calls to the backend. Owns auth headers and error propagation. |
| `auth.js` | PKCE flow and token storage. No UI. |
| `graph.js`, `structure.js`, `board.js` | Self-contained view modules; receive DOM containers, call `store`, render, done. |

**State**

- Client state lives in `store.js` and module-level `let` variables inside each view module.
- No globals except the ES module graph itself.
- Persistent state: `localStorage` via `store.js`; user preferences (theme) via `theme.js`.

**Style**

- CSS custom properties for all colours and spacing — no hard-coded hex values in component styles.
- All theme-variant colours go in `:root` (dark default) and `[data-theme="light"]` override blocks in `style.css`.
- Class names follow a short-prefix convention: `.gnode` / `.gedge` (graph), `.str-*` (structure), `.board-*` (board), `.ai-*` (AI panel).

**Comments**

Write a comment only when the *why* is non-obvious — a hidden constraint, a workaround, a subtle invariant. Don't describe what the code does; well-named identifiers do that.

---

## Backend (Lambda / Python)

The Lambda handler is `infra/lambda/index.py`. It uses [Strands agents SDK](https://strandsagents.com) for Bedrock tool-calling.

- One handler function routes on `httpMethod` + `path`.
- AI jobs are async: `POST /jobs` returns a job ID immediately; the client polls `GET /jobs/{id}`.
- Large text inputs (>100KB) are stored in S3 before the Lambda exits so the job runner can retrieve them without DynamoDB's 400KB limit.
- Structure extraction runs in two phases: parallel chunk extraction via `ThreadPoolExecutor`, then a merge agent that reconciles duplicates.

### Local testing

```bash
cd infra/lambda
pip install -r requirements.txt

# Unit-style: import and call handler functions directly
python3 -c "from index import get_features; print(get_features({}, {}))"
```

### Smoke tests

```bash
pip install nova-act
python3 tests/smoke.py
```

Smoke tests use Nova Act to drive a real browser session. They require a deployed backend and valid credentials in the environment.

---

## Vendor bundles

D3 and Transformers.js are self-hosted ESM bundles built with esbuild. Update them only when you need a new library version:

```bash
./infra/vendor-deps.sh
```

This script installs the npm packages, bundles them, uploads to S3, and patches the importmap in `index.html`.

---

## Pull request process

1. Fork and create a branch from `main`.
2. Keep PRs focused — one feature or fix per PR.
3. Test locally with `python3 -m http.server 8080` and exercise the affected views manually.
4. If you touched the Lambda, run the smoke tests against a dev deployment.
5. Update `README.md` if you added a new feature or changed the deployment process.
6. Open the PR against `main`. Describe what changed and why, not how.

---

## What to work on

Check open issues. Good starting points for first contributions:

- Accessibility: keyboard navigation in the graph and board views
- Mobile layout: the three-panel layout breaks below ~900px
- Export formats: Markdown, Obsidian vault, Scrivener-compatible output
- Timeline: visual lane-based rendering for overlapping events
- Offline-first: Service Worker caching so the app loads without a network connection
