# TradeX ERP — Meat Trading, Processing & Logistics

Operational ERP for one legal entity with two divisions (Meat Trading & Processing; Logistics),
integrated with a single authoritative TallyPrime 7.0 installation.

- Project state and next action: `STATUS.md` (always read first)
- Agent rules: `CLAUDE.md`
- Architecture: `docs/ARCHITECTURE.md`
- Development plan and phase order: `docs/DEVELOPMENT_PLAN.md`
- Prompt library: `prompts/PROMPT_REGISTRY.md`

## Commands

Canonical command table and verification status: `docs/QUALITY_GATES.md` §1. Requires Node 24+ and pnpm 12.

```bash
pnpm install --frozen-lockfile                          # install from lockfile
docker compose -f deploy/compose.dev.yml up -d db       # dev Postgres on 127.0.0.1:5432 (needs Docker)
pnpm --filter @tradex/api dev                           # API (copy apps/api/.env.example to apps/api/.env first)
pnpm --filter web dev                                   # web (Vite dev server, proxies /api)
pnpm lint && pnpm typecheck                             # static checks
pnpm test                                               # unit tests, all packages
pnpm --filter api test <pattern>                        # unit tests, one package, filtered
pnpm test:integration                                   # API integration tests (needs the dev DB up)
pnpm --filter api db:migrate                            # apply migrations (tradex_owner, DATABASE_URL_MIGRATE)
pnpm --filter api db:codegen                            # regenerate src/db/generated.ts from the migrated DB
pnpm build                                              # build all packages
pnpm --filter web e2e                                   # Playwright smoke (uses installed Chrome locally)
```

Dev database: DBs `tradex_dev` and `tradex_test`; roles `tradex_owner` (DDL) and `tradex_app` (DML only).
Dev-only default passwords are in `.env.example`. Reset the database with
`docker compose -f deploy/compose.dev.yml down -v`.
