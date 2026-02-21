# Planned Improvements

This file tracks potential improvements to the codebase. None of these are currently in progress — they are documented here for future reference.

Referenced from [CLAUDE.md](./CLAUDE.md).

---

## Priority 1: Testing

**Add integration tests for core endpoints.**

There are currently no tests. Adding tests for the export and enrich endpoints would:
- Catch regressions like the JOIN fan-out bug (commit `c387167`) before production
- Enable a faster AI-assisted development loop (change → run tests → confirm)
- Provide confidence when refactoring

Suggested approach:
- Use a test framework (Jest or Vitest)
- Test endpoint validation (Zod schemas rejecting bad input)
- Test CSV parsing and column detection logic with sample data
- Test the SQL WHERE clause builder with various filter combinations
- Integration tests against a test database for the full export/enrich flow

## Priority 2: Split `index.ts`

**Break the single file into focused modules when it grows past ~2,000 lines.**

Suggested structure:
```
src/
  index.ts          — app setup, middleware, server start
  routes/
    export.ts       — export endpoint + processing
    enrich.ts       — enrichment endpoint + processing
    health.ts       — health check
  lib/
    db.ts           — pool setup, Prisma client
    auth.ts         — authentication middleware
    csv.ts          — CSV helpers (escape, column detection, address formatting)
    sql.ts          — WHERE clause builder, cursor query builder
  types.ts          — shared interfaces and types
```

Benefits:
- AI tools work better with focused, smaller files
- Reduces merge conflicts if multiple people contribute
- Each module can be reasoned about independently

## Priority 3: Remove `dist/` from git

**Build artifacts should not be tracked in source control.**

Currently `dist/` is committed, which means every code change produces a double diff. This clutters git history and confuses AI tools trying to understand changes.

Steps:
1. Add `dist/` to `.gitignore`
2. Remove from tracking: `git rm -r --cached dist/`
3. Ensure the Docker build and deployment process runs `npm run build`

## Priority 4: Rate limiting and abuse protection

**Add basic protection for public-facing endpoints.**

Currently missing:
- No rate limiting middleware on any endpoint
- No request size limits beyond multer's 50 MB file limit
- The status polling endpoint (`GET /api/addresses/export/status`) is unauthenticated and has no rate limit

Suggested approach:
- Add `express-rate-limit` for global and per-endpoint rate limiting
- Consider adding auth to the status endpoint or rate limiting it more aggressively

## Priority 5: Simplify database access

**Evaluate whether Prisma is still needed.**

Prisma is currently used only for simple job CRUD (create, findUnique, update). All heavy operations use raw `pg`. This means:
- Two database access patterns to maintain
- Prisma client generation adds build complexity
- Schema migrations are tied to Prisma but most queries bypass it

Options:
- Drop Prisma entirely and use `pg` for everything (simpler, one pattern)
- Lean into Prisma more by using it for the cursor-based queries where possible (cleaner, but may hit Prisma limitations with raw cursors)
