# CLAUDE.md — Address Export Server

## What this is

A single-process Node.js/Express server that handles two main operations for a Dutch address database (ContactBuddy.nl):
1. **Export** — filter and export addresses as CSV/ZIP files
2. **Enrichment** — upload a CSV of addresses and enrich it with BAG, energy label, WOZ, coordinate, and address data

## Commands

| Action | Command |
|---|---|
| Dev server (hot reload) | `npm run dev` |
| Build | `npm run build` |
| Start production | `npm start` |
| Lint | `npm run lint` |
| Prisma generate | `npx prisma generate` |

No test framework is configured. There are no tests.

## Architecture

**Single-file app.** All code lives in `src/index.ts`. Endpoints, processing logic, helpers, and types are co-located. There are no separate route/service/controller files.

**Two database access patterns coexist:**
- **Prisma** — used only for simple metadata CRUD (creating/updating job records)
- **Raw `pg` Pool** — used for all heavy data operations (exports, enrichment queries, cursor-based streaming)

**Async job pattern** — all long-running operations follow this flow:
1. Endpoint validates input, creates a job record via Prisma, returns `jobId` immediately
2. A `process*()` function runs in the background (fire-and-forget with `.catch()`)
3. Client polls `GET /api/addresses/export/status?jobId=...` for progress
4. On completion, the job record is updated with a Vercel Blob download URL

**Server-side cursors** — large queries use `BEGIN` → `DECLARE CURSOR` → `FETCH 5000` in a loop → `CLOSE` → `COMMIT`. Never loads full result sets into memory.

**Separate progress connection** — async jobs acquire two pool clients: one holds the cursor transaction, the other writes progress/cancellation updates so they're visible immediately outside the transaction.

## Key conventions

- **Validation**: Zod schemas for request validation
- **Auth**: Bearer token via `Authorization` header. Health and status endpoints are public.
- **CSV output**: UTF-8 with BOM (`0xEF 0xBB 0xBF`) for Excel compatibility
- **File storage**: Vercel Blob via `@vercel/blob` `put()`
- **Dutch domain**: Column names, some error messages, and domain concepts are Dutch (postcode, huisnummer, woonplaats, etc.)
- **CORS**: Locked to specific frontend domains (Vercel, ContactBuddy, localhost)

## Database

- PostgreSQL hosted on Neon
- Schema: `prisma/schema.prisma`
- Key tables/views used in code: `address_export`, `energy_label_enrichment`, `woz_address_enrichment`, `export_jobs`
- Connection pool: max 10, 30s timeouts, SSL with `rejectUnauthorized: false`

## API endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/addresses/export` | Yes | Create async export job |
| GET | `/api/addresses/export/status` | No | Poll job status (export + enrichment) |
| POST | `/api/addresses/export/cancel` | Yes | Cancel a running job |
| POST | `/api/addresses/enrich` | Yes | Upload CSV for enrichment |
| GET | `/health` | No | Health check |

## Deployment

- Docker via `Dockerfile.dockerfile` + `docker-compose.yml`
- Port 3001 (configurable via `PORT` env var)
- Target: DigitalOcean Droplet or App Platform
- `dist/` (compiled JS) is currently tracked in git

## When making changes

- Add new endpoints and processing logic directly to `src/index.ts`
- Follow the existing async job pattern for any new long-running operations
- Use raw `pg` with cursors for heavy queries, Prisma for simple record operations
- Keep the README.md updated when adding/changing endpoints or parameters
- Commits go directly to `main` — no PR workflow enforced

## Future improvements

See [IMPROVEMENTS.md](./IMPROVEMENTS.md) for a prioritized list of planned improvements (not currently in progress).
