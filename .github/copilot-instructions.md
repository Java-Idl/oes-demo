# Copilot instructions for oes-demo

## Project snapshot

This repository is a security-focused demo of an online examination system: a plain HTML/CSS/JavaScript frontend, a Node.js + Express backend, and a PostgreSQL 16 database. The app is designed to run as a Docker Compose stack, not as a framework app with a conventional build pipeline.

## Build, test, and lint commands

There is no test or lint automation configured in `app/package.json` today. The repository expects Docker-based startup rather than a local framework build step.

Use the stack as the primary validation path:

```bash
cp .env.example .env
# edit .env with real secrets if you plan to use it outside the demo

docker compose up --build
```

Useful repo-specific commands:

```bash
# stop the stack, keep data volume intact
docker compose down

# stop and reset the database (required after db/init changes)
docker compose down -v

# follow app logs
docker compose logs -f app

# optional DB browser
docker compose --profile tools up
```

If you want to run only the app locally instead of the full stack, use:

```bash
cd app
npm install
npm start
```

There is no single-test command in this repo; there are no automated unit or integration tests defined by package scripts right now.

## High-level architecture

The selected architecture is important to understand before changing code:

- `docker-compose.yml` defines the runtime: a `db` PostgreSQL service and an `app` Node service. The database is not published to the host; it is only reachable from the app container.
- `db/init/01_schema.sql` is the authoritative schema. It creates roles, users, sessions, courses, exams, attempts, results, and the append-only audit table with triggers that enforce integrity and immutability.
- `app/src/server.js` boots the Express app, applies global security headers, mounts the API under `/api`, and serves static files from `app/public`.
- `app/src/auth.js` owns authentication, session loading, CSRF protection, login throttling, and role enforcement. This is the central security boundary for the app.
- `app/src/routes/*.js` are the feature modules:
  - `student.js`: exam start/resume/answer/save/submit, result viewing
  - `faculty.js`: exam creation, grading, publish flow
  - `admin.js`: user management and audit verification
- `app/src/exams.js` contains the exam lifecycle logic (phase checks, grading, finalization, auto-submission).
- `app/src/security.js` and `app/src/audit.js` implement encryption, HMAC validation, hash-chain auditing, and tamper-evident result verification.
- `app/public` contains the browser UI files served as static assets; the app is not a build-based frontend framework.

## Repository conventions and guardrails

These are the repo-specific patterns that matter during development:

- Parameterized SQL only. Use the `db.query()` and `db.tx()` helpers in `app/src/db.js` instead of concatenating SQL strings. This is enforced by the design and by explicit comments in the project.
- Default-deny security model. API routes are mounted under role-specific paths (`/api/student`, `/api/faculty`, `/api/admin`), and `auth.requireRole(...)` rejects unauthorized access. Do not bypass this in feature work.
- Session and CSRF protections are part of the app contract. The app stores only a SHA-256 hash of the session token in the database and uses `HttpOnly; SameSite=Strict` cookies. State-changing requests also require the `X-Requested-With: fetch` header and origin checks.
- Sensitive data is handled with explicit security primitives. Answer keys are encrypted with AES-256-GCM; published results are HMAC-signed; audit entries use a hash chain to detect tampering. Preserve these flows when making changes.
- Generic browser errors are intentional. Detailed server-side errors should be logged on the server, not exposed to end users.
- The app seeds demo data automatically on startup. If you modify `db/init/*`, reset the database with `docker compose down -v` because the schema is generated only on the first `db` container startup.
- The README is useful, but the Compose file is the authoritative runtime definition. For example, the current `docker-compose.yml` publishes the app on `localhost:8919`, even though older docs may mention another port; verify the compose config before telling someone to open a browser URL.

## Working safely in this repo

When changing code in this project, prefer the same patterns the app already uses:

- keep API logic in the existing route modules; do not invent a separate application layer unless the change is clearly part of the current architecture
- preserve audit logging for security-sensitive actions
- keep role ownership checks aligned with `req.user` and the route-specific data scope
- avoid broad refactors that remove the demo’s security controls; this project is intentionally security-aware, not a generic CRUD app
