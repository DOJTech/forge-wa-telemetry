# The Forge: West Africa Telemetry Sandbox

Sandbox for scoring `schema_wa_v1` compliance dispute payloads.

- `public/` static UI (Render static site)
- `api/` Node/Express API with PostgreSQL audit log (Render web service)
- `render.yaml` Render Blueprint for all three resources

Deploy: push to `main`; the Render Blueprint syncs automatically.

Endpoint: `POST /api/v1/dispute/score`  |  Health: `GET /health`

Use synthetic test data only. Do not put real customer or card data in this system.
