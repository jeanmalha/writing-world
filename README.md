# Writing World

A world-building knowledge base for fiction writers.
Manage characters, locations, factions, species, events, artifacts and lore — with linked relations and a timeline.
Runs entirely in the browser — no build step, no backend.

Live at **[lore.malha.land](https://lore.malha.land)**

---

## Features

### Entity Types
- **Characters** — people, AIs, aliens, or any individual; role and status fields
- **Locations** — planets, stations, cities, regions; type and star system fields
- **Factions** — governments, corporations, cults, crews; type and headquarters fields
- **Species** — any kind of being; homeworld and key traits fields
- **Events** — plot points and historical moments; date and importance fields (feeds the Timeline)
- **Artifacts** — weapons, devices, ships, documents; type and origin fields
- **Lore** — world-building rules, history, culture, technology; free-form category field

### Relations
- Link any entity to any other with a free-text relation label (e.g. "sibling of", "stationed at", "member of")
- View both outgoing links and incoming back-references from a single entity's detail panel
- Click any linked entity to jump directly to it

### Timeline
- Dedicated Timeline view that collects all Events and sorts them by their Date field
- Events are colour-coded by importance: Critical, Major, Minor, Background
- Date field is free-text — use whatever calendar system your world requires

### Search
- Global full-text search across all entity types
- Matches against name, description, and tags

### Save / Load
- Auto-saves every change to browser localStorage
- **Export JSON** — full world data as a single `.json` file
- **Import JSON** — restore any previously exported world

---

## Project Structure

```
writing-world/
├── index.html          # App shell and layout
├── style.css           # Dark monospace theme, all component styles
├── js/
│   ├── app.js          # State, rendering, event handling
│   └── store.js        # Entity CRUD, localStorage persistence, search, timeline, import/export
└── infra/
    ├── stack.yaml          # CloudFormation: S3 + CloudFront + ACM + Route53
    ├── monitoring.yaml     # CloudFormation: CloudWatch alarms + AWS Budget
    ├── deploy.sh           # Sync to S3 + CloudFront invalidation
    ├── deploy-monitoring.sh
    └── deploy.env.example  # Config template (copy to deploy.env, never commit)
```

---

## Running Locally

```bash
# Any static file server works — file:// won't work with ES modules
npx serve .
# or
python3 -m http.server 8080
```

Open `http://localhost:8080`.

---

## Deployment (AWS)

Infrastructure is managed via CloudFormation in `infra/`.

### First deploy

```bash
# 1. Copy and fill in your config
cp infra/deploy.env.example infra/deploy.env
# edit infra/deploy.env — set AWS_PROFILE and DOMAIN

# 2. Deploy main stack (S3 + CloudFront + ACM + Route53)
#    Must run in us-east-1 for ACM + CloudFront
./infra/deploy.sh

# 3. Copy the DistributionId from the output, add it to deploy.env as DIST_ID

# 4. Deploy monitoring (budget alerts + CloudWatch alarms)
./infra/deploy-monitoring.sh your@email.com 10
```

### Subsequent deploys

```bash
./infra/deploy.sh sync
```

Syncs static files to S3 with correct cache headers and creates a CloudFront invalidation.

### Cache strategy
- `index.html` — `max-age=3600`; CloudFront invalidation on every deploy keeps the CDN fresh
- `style.css` and `js/*.js` — `max-age=31536000, immutable`; a Unix timestamp is injected as `?v=<ts>` into every asset URL at deploy time so browsers always fetch fresh files after a release
