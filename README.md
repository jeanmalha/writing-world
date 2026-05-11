# Lore

A worldbuilding knowledge base for fiction writers.
Manage characters, locations, factions, species, events, artifacts and lore — with linked relations, a timeline, an interactive graph, and AI-assisted extraction.

Live at **[lore.malha.land](https://lore.malha.land)**

---

## Features

| Feature | Description |
|---|---|
| **Entities** | 7 types (Character, Location, Faction, Species, Event, Artifact, Lore) with typed fields, free-text description, tags, and bi-directional links |
| **Timeline** | Collects all Events sorted chronologically; colour-coded by importance; supports free-text dates including named months |
| **Board** | Kanban-style sticky-note board for plotting and scene planning |
| **Graph** | D3 force-directed graph of all entities and their relationships; drag to reposition, toggle visibility by type or relation label |
| **Book Structure** | Hierarchical Acts / Chapters / Scenes tree with reordering, entity links, and notes |
| **AI Extract (cloud)** | Send manuscript text to a Bedrock-backed agent that extracts entities and optionally book structure; parallel chunking for large texts |
| **AI Assistant (local)** | In-browser SmolLM2-360M via Transformers.js and WebGPU/WASM; answers questions about your world without sending data to the cloud |
| **Multi-project** | Each signed-in user can maintain independent projects |
| **Saves** | Local-first: auto-saves to `localStorage`, named snapshots, JSON export/import |
| **Themes** | Light / Dark / System preference |

---

## Project Structure

```
lore/
├── index.html              # App shell and layout
├── favicon.svg             # Open book icon
├── style.css               # Dark monospace theme (light variant via data-theme="light")
├── js/
│   ├── app.js              # View routing, sidebar, event wiring
│   ├── store.js            # Entity and structure CRUD, localStorage, search, timeline sort, import/export
│   ├── auth.js             # PKCE OAuth flow with Cognito; getUserTier()
│   ├── api.js              # Fetch helpers for the backend API (auth header, error handling)
│   ├── config.js           # Runtime config (API URL, Cognito pool/client IDs)
│   ├── project.js          # Multi-project selector UI
│   ├── theme.js            # Light/dark/system theme switching
│   ├── graph.js            # D3 force graph view
│   ├── structure.js        # Book structure tree view (Acts/Chapters/Scenes)
│   ├── board.js            # Kanban board view
│   ├── ai-panel.js         # Cloud AI extract/analyze panel
│   ├── chat.js             # Local in-browser assistant panel
│   ├── llm.js              # Transformers.js inference wrapper (SmolLM2)
│   ├── admin.js            # Admin panel (users, feature flags, interest analytics)
│   └── splash.js           # Splash / interest-capture screen for new visitors
├── infra/
│   ├── stack.yaml              # CloudFormation: S3 + CloudFront + ACM + Route53
│   ├── backend-stack.yaml      # CloudFormation: API Gateway, Lambda, DynamoDB, Cognito, Athena
│   ├── monitoring.yaml         # CloudFormation: CloudWatch alarms + AWS Budget
│   ├── deploy.sh               # Sync frontend to S3 + CloudFront invalidation
│   ├── deploy-backend.sh       # Package and deploy Lambda + API stack
│   ├── deploy-monitoring.sh    # Deploy CloudWatch/budget stack
│   ├── vendor-deps.sh          # Build and self-host D3 + Transformers.js bundles to S3
│   ├── lambda/
│   │   ├── index.py            # Lambda handler (entities, structure jobs, feature flags, admin)
│   │   └── requirements.txt    # strands-agents, boto3
│   ├── deploy.env.example      # Config template (copy to deploy.env, never commit)
│   └── backend.env.example     # Backend config template
└── tests/
    └── smoke.py                # Nova Act smoke tests (login, entity CRUD, AI extract)
```

---

## Running Locally

No build step required — Lore is plain ES modules.

```bash
# Any static file server works (file:// breaks ES module imports)
npx serve .
# or
python3 -m http.server 8080
```

Open `http://localhost:8080`.

The app works fully offline for local-only use (entities, board, graph, structure, saves).
Cloud AI features (extract, structure extraction) and authentication require the backend.

---

## Architecture

```
Browser (vanilla JS ES modules)
  ├── store.js         localStorage ↔ entity/structure data
  ├── auth.js          PKCE → Cognito User Pool
  ├── api.js           → API Gateway HTTP API (JWT-authenticated)
  │                        ├── GET  /entities         (sync)
  │                        ├── POST /jobs             (AI extract / structure)
  │                        ├── GET  /jobs/{id}        (poll)
  │                        ├── GET  /features         (public feature flags)
  │                        └── GET|PUT /admin/*       (admin only)
  └── llm.js           → Transformers.js (WebGPU/WASM, fully local)
                           SmolLM2-360M-Instruct
                           Model weights fetched from Hugging Face on first use

Lambda (Python 3.12, Strands agents SDK)
  ├── Entity CRUD      → DynamoDB
  ├── AI extract       → Bedrock (Claude) via strands-agents
  ├── Structure jobs   → Text stored in S3 (>400KB safe); parallel chunk extraction + merge agent
  ├── Feature flags    → DynamoDB FeatureFlagsTable
  └── Admin interest   → S3 submissions/ prefix (direct scan)

Vendor bundles (self-hosted on CloudFront)
  ├── /vendor/d3.mjs           d3-force + d3-drag + d3-zoom + d3-selection (esbuild, 132KB)
  ├── /vendor/lore-ai.mjs      @huggingface/transformers (esbuild, ~3MB)
  └── /vendor/ort-webgpu.mjs   onnxruntime-web/webgpu
```

---

## Deployment

### Prerequisites

- AWS account with SSO configured (`aws sso login --profile <profile>`)
- A registered domain in Route53

### Frontend

```bash
cp infra/deploy.env.example infra/deploy.env
# Fill in: AWS_PROFILE, DOMAIN, DIST_ID (after first deploy)

# First deploy (creates S3 bucket, CloudFront, ACM cert, Route53 records)
./infra/deploy.sh

# Subsequent deploys
./infra/deploy.sh sync
```

Asset versioning: a Unix timestamp `?v=<ts>` is injected into every `js/` and `style.css` URL in `index.html` at deploy time so browsers always pick up new files after a release.

### Backend

```bash
cp infra/backend.env.example infra/backend.env
# Fill in: AWS_PROFILE, DOMAIN, COGNITO_DOMAIN, etc.

./infra/deploy-backend.sh
```

This packages the Lambda layer (Strands agents + deps), deploys the CloudFormation stack, and prints the API URL to add to `js/config.js`.

### Vendor bundles (AI + D3)

Only needed when updating library versions:

```bash
./infra/vendor-deps.sh
```

Builds self-contained ESM bundles via esbuild and uploads them to S3. Updates the importmap in `index.html` automatically.

### Monitoring

```bash
./infra/deploy-monitoring.sh your@email.com 10   # alert threshold: $10
```

---

## Feature Flags

Feature availability is controlled via DynamoDB and served at `GET /features` (no auth required). Admins can toggle flags from the admin panel.

Current flags:
- `assistant.enabled` — show/hide the local AI assistant button
- `assistant.model` — `"360M"` or `"1.7B"` (larger model requires more VRAM)

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
