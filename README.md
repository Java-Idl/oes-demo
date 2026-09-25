# ExamSecure – Online Examination System (demo)

A working demo of the secure software model in the report: students take timed online exams, faculty create exams, grade and publish results, and administrators manage users and audit the system.

- **Frontend:** plain HTML, CSS and JavaScript (no frameworks, no build step).
- **Backend:** Node.js + Express (3 dependencies: `express`, `pg`, `bcryptjs`).
- **Database:** PostgreSQL 16.
- **Everything runs in Docker.**

## Run it

You need Docker Desktop (or Docker Engine with the Compose plugin).

```bash
cd oes-demo
cp .env.example .env          # Windows: copy .env.example .env   (change the secrets for anything real)
docker compose up --build
```

Open **http://localhost:8080**.

| Role | Sign in with | Password |
|---|---|---|
| Administrator | `admin@oes.local` | `Admin@12345` |
| Faculty | `priya@oes.local` (or `ravi@oes.local`) | `Faculty@12345` |
| Student | `22CCE1001`, `22CCE1002`, `22CCE1003` (roll no. or email) | `Student@12345` |

Useful commands:

```bash
docker compose down            # stop (data is kept)
docker compose down -v         # stop AND wipe the database (fresh demo data next start)
docker compose logs -f app     # watch the app log (notifications are printed here)
docker compose --profile tools up   # also starts Adminer DB browser on http://localhost:8081
```

In Adminer use server `db` and the owner account from `.env` (`oes_owner`).

## Demo data (created on first start)

| Exam | Course | State | What to try |
|---|---|---|---|
| Mid-Term 2 | 19CCE301 | **Live now** (window: 3 hours, 30 min each) | Sign in as a student and take it |
| Quiz 3 | 19CCE305 | Upcoming (tomorrow) | "Start" is disabled until the window opens |
| Mid-Term 1 | 19CCE301 | Closed, not published, 1 answer needs manual grading | As `priya`: grade it, then publish |
| Quiz 1 | 19CCE305 | Published | Students see their results and the integrity check |

## Suggested walkthrough

1. **Student `22CCE1001`** → Start *Mid-Term 2* → answer, mark for review, jump via the palette, close the tab and come back (answers are restored) → Submit → keep the receipt hash.
2. **Faculty `priya`** → *Mid-Term 1* → Review & Publish → Publish is disabled while 1 answer is ungraded → grade it → Publish → enter the wrong password (refused), then the right one.
3. **Student `22CCE1003`** → My Results → *Mid-Term 1* shows **Verified**.
4. **Admin** → Audit Log → every step above is logged → **Verify hash chain**.
5. Try the attacks below.

## Security features and how to see them

| Report item | Implemented as | Try this |
|---|---|---|
| SR-01 passwords | bcrypt hashes; min. 10 characters | Create a user with a short password (refused) |
| SR-03 lockout (V04) | 5 wrong passwords → locked 15 min; admin can unlock | Enter a wrong password 5 times |
| SR-04 sessions (V05) | 256-bit random token in an `HttpOnly; SameSite=Strict` cookie, only its SHA-256 stored in DB, new token at every login, 15-min idle / 3-h absolute timeout | DevTools → `document.cookie` is empty |
| SR-05 authorization (V02, V03) | Role check on every API route (deny by default) + ownership check on every exam/attempt/result | As a student call `/api/faculty/exams`; as `priya` open Ravi's exam; as one student open another's result → 403/404 + `ACCESS_DENIED` / `IDOR_BLOCKED` in the audit log |
| SR-07 answer keys (V06) | Keys encrypted with AES-256-GCM; the student question API never selects them | DevTools → Network → `/start` response has no key |
| FR-06/NFR-08 timing (V08) | Deadline stored and enforced on the server; auto-submit job every 15 s; one attempt per student (DB unique constraint) | Change the PC clock – the timer does not move the deadline |
| SR-08 marks integrity (V09) | HMAC on every published result, verified on every read; marks frozen after publish (app check **and** DB trigger); publish needs re-authentication | See "Tamper test" below |
| SR-09 input handling (V01, V07) | Parameterised SQL only; all text rendered with `textContent`; strict Content-Security-Policy | Create an exam titled `<b>X</b>` – it shows as plain text |
| SR-10 audit (T06, T07) | Append-only table (trigger + no UPDATE/DELETE grant) with a SHA-256 hash chain | See "Tamper test" below |
| SR-11 least privilege | App connects as `oes_app`: no DDL, only INSERT/SELECT on `results` and `audit_log` | See "Tamper test" below |
| V11 CSRF | `SameSite=Strict` cookie + required `X-Requested-With` header + Origin check | `curl -X POST localhost:8080/api/auth/logout` → blocked |
| V12 errors | Generic error messages to the browser; details only in the server log | – |
| TB2 data tier | The database has no published port; only the app container can reach it | `psql -h localhost` from your PC fails |

### Tamper test (integrity + audit)

```bash
# 1. The app's own DB account cannot change results or delete audit entries:
docker compose exec db psql -U oes_app -d oes -c "UPDATE results SET total_score = 100;"
#    -> ERROR: permission denied for table results

# 2. Even the owner is blocked by triggers:
docker compose exec db psql -U oes_owner -d oes -c "DELETE FROM audit_log;"
#    -> ERROR: audit_log is append-only

# 3. A determined DBA disables the trigger and edits a row...
docker compose exec db psql -U oes_owner -d oes -c "ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only; UPDATE audit_log SET action='LOGIN_SUCCESS' WHERE log_id=3; ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only;"
#    ...and Admin -> Audit Log -> "Verify hash chain" reports: Chain BROKEN at entry #3.

# Same idea for marks: change a published result as the owner and the student sees "TAMPERED".
docker compose exec db psql -U oes_owner -d oes -c "ALTER TABLE results DISABLE TRIGGER results_immutable; UPDATE results SET total_score = 13; ALTER TABLE results ENABLE TRIGGER results_immutable;"
```

(With the default `.env`, the owner password is not needed inside the container.)

## Architecture (matches the Level 1 DFD)

```
Browser (untrusted)  --TB1-->  app container: Node/Express  --TB2-->  db container: PostgreSQL
  public/*.html, js, css         src/auth.js     1.0 Authenticate & sessions      D1 users/roles/students/faculty
                                 src/routes/faculty.js  2.0 Exams & questions      D2 sessions
                                 src/routes/student.js  3.0 Conduct exam           D3 courses/exams/questions
                                 src/exams.js    4.0 Submission & evaluation       D4 attempts/answers
                                 src/routes/faculty.js  5.0 Publish results        D5 results
                                 src/routes/admin.js    6.0 Users & audit          D6 audit_log
                                 console log  --TB3-->  "Notification Service" (simulated)
```

```
oes-demo/
├── docker-compose.yml
├── .env.example
├── db/init/01_schema.sql      tables (ER diagram), triggers
├── db/init/02_app_role.sh     least-privilege app account
└── app/
    ├── Dockerfile
    ├── src/  server.js, config.js, db.js, auth.js, security.js, audit.js, exams.js, seed.js, routes/
    └── public/  index.html (login), student.html, exam.html, faculty.html, faculty-exam.html, admin.html, css/, js/
```

## Simplifications (it is a demo)

- **No MFA/OTP** step for staff (SR-02); publishing does require password re-authentication.
- **HTTP, not HTTPS.** Put it behind a TLS reverse proxy and set `COOKIE_SECURE=true` for real use.
- The login rate limiter is in memory (resets on restart; single instance only).
- The notification service is simulated with a log line.
- Re-evaluation after publishing (FR-15) is not implemented; published marks are simply frozen.
- The schema is created only on the **first** start. After changing `db/init/*`, run `docker compose down -v`.
