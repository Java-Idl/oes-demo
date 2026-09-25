#!/bin/sh
# Creates the least-privilege account the application uses (SR-11).
# The app can read/write normal tables but can only INSERT/SELECT
# audit_log and results - no UPDATE/DELETE on them and no DDL rights.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<EOSQL
CREATE ROLE ${APP_DB_USER} LOGIN PASSWORD '${APP_DB_PASSWORD}';
GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO ${APP_DB_USER};
GRANT USAGE ON SCHEMA public TO ${APP_DB_USER};
GRANT SELECT, INSERT, UPDATE, DELETE ON
  roles, users, sessions, students, faculty, courses, enrollments,
  exams, questions, exam_questions, attempts, answers
  TO ${APP_DB_USER};
GRANT SELECT, INSERT ON audit_log, results TO ${APP_DB_USER};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_DB_USER};
EOSQL
