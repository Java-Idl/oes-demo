-- =====================================================================
-- Online Examination System - database schema (PostgreSQL 16)
-- Mirrors the ER diagram in the report (Section 4).
-- Runs automatically the first time the db container starts.
-- =====================================================================

CREATE TABLE roles (
  role_id    SERIAL PRIMARY KEY,
  role_name  TEXT NOT NULL UNIQUE CHECK (role_name IN ('STUDENT','FACULTY','ADMIN'))
);
INSERT INTO roles (role_name) VALUES ('STUDENT'), ('FACULTY'), ('ADMIN');

CREATE TABLE users (
  user_id          SERIAL PRIMARY KEY,
  role_id          INT NOT NULL REFERENCES roles(role_id),
  full_name        TEXT NOT NULL,
  email            TEXT NOT NULL UNIQUE,
  password_hash    TEXT NOT NULL,                       -- bcrypt (SR-01)
  status           TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  failed_attempts  INT  NOT NULL DEFAULT 0,             -- lockout (SR-03)
  locked_until     TIMESTAMPTZ,
  last_login       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,                         -- only a SHA-256 of the cookie is stored (SR-04)
  user_id     INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  ip_address  TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL                      -- absolute timeout
);
CREATE INDEX ON sessions(user_id);

CREATE TABLE students (
  student_id  SERIAL PRIMARY KEY,
  user_id     INT NOT NULL UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
  roll_no     TEXT NOT NULL UNIQUE,
  department  TEXT,
  batch       TEXT
);

CREATE TABLE faculty (
  faculty_id   SERIAL PRIMARY KEY,
  user_id      INT NOT NULL UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
  department   TEXT,
  designation  TEXT
);

CREATE TABLE courses (
  course_id    SERIAL PRIMARY KEY,
  faculty_id   INT NOT NULL REFERENCES faculty(faculty_id),
  course_code  TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL
);

CREATE TABLE enrollments (
  enrollment_id  SERIAL PRIMARY KEY,
  student_id     INT NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  course_id      INT NOT NULL REFERENCES courses(course_id) ON DELETE CASCADE,
  enrolled_on    DATE NOT NULL DEFAULT CURRENT_DATE,
  UNIQUE (student_id, course_id)
);

CREATE TABLE exams (
  exam_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),   -- non-guessable ids (V02)
  course_id     INT NOT NULL REFERENCES courses(course_id),
  created_by    INT NOT NULL REFERENCES faculty(faculty_id),
  title         TEXT NOT NULL,
  start_time    TIMESTAMPTZ NOT NULL,
  end_time      TIMESTAMPTZ NOT NULL,
  duration_min  INT NOT NULL CHECK (duration_min > 0),
  total_marks   NUMERIC(6,2) NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SCHEDULED','PUBLISHED')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_time > start_time)
);

CREATE TABLE questions (
  question_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id       INT NOT NULL REFERENCES courses(course_id),
  q_type          TEXT NOT NULL CHECK (q_type IN ('MCQ','TEXT')),
  q_text          TEXT NOT NULL,
  options         JSONB,                                      -- MCQ options (multi-valued attribute)
  answer_key_enc  TEXT,                                       -- AES-256-GCM encrypted (SR-07)
  marks           NUMERIC(5,2) NOT NULL CHECK (marks > 0),
  difficulty      TEXT
);

CREATE TABLE exam_questions (
  exam_id      UUID NOT NULL REFERENCES exams(exam_id) ON DELETE CASCADE,
  question_id  UUID NOT NULL REFERENCES questions(question_id),
  seq_no       INT NOT NULL,
  PRIMARY KEY (exam_id, question_id)
);

CREATE TABLE attempts (
  attempt_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id          UUID NOT NULL REFERENCES exams(exam_id),
  student_id       INT  NOT NULL REFERENCES students(student_id),
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deadline         TIMESTAMPTZ NOT NULL,                      -- server-side timer (V08)
  submitted_at     TIMESTAMPTZ,
  status           TEXT NOT NULL DEFAULT 'IN_PROGRESS'
                   CHECK (status IN ('IN_PROGRESS','SUBMITTED','AUTO_SUBMITTED')),
  ip_address       TEXT,
  submission_hash  TEXT,
  UNIQUE (exam_id, student_id)                                -- one attempt per student
);

CREATE TABLE answers (
  answer_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id     UUID NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  question_id    UUID NOT NULL REFERENCES questions(question_id),
  response       TEXT,
  marks_awarded  NUMERIC(5,2),
  graded_by      INT REFERENCES faculty(faculty_id),
  saved_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, question_id)
);

CREATE TABLE results (
  result_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id      UUID NOT NULL UNIQUE REFERENCES attempts(attempt_id),
  total_score     NUMERIC(6,2) NOT NULL,
  grade           TEXT NOT NULL,
  published_by    INT NOT NULL REFERENCES faculty(faculty_id),
  published_at    TIMESTAMPTZ NOT NULL,
  integrity_hash  TEXT NOT NULL,                              -- HMAC (SR-08)
  version         INT NOT NULL DEFAULT 1
);

CREATE TABLE audit_log (
  log_id      BIGSERIAL PRIMARY KEY,
  user_id     INT REFERENCES users(user_id),
  action      TEXT NOT NULL,
  entity      TEXT,
  entity_id   TEXT,
  details     JSONB,
  ip_address  TEXT,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  prev_hash   TEXT NOT NULL,
  entry_hash  TEXT NOT NULL                                   -- hash chain (SR-10)
);

-- ---------------------------------------------------------------------
-- Defence in depth: even with SQL access, audit entries and published
-- results cannot be changed, and marks freeze once results are published.
-- ---------------------------------------------------------------------
CREATE FUNCTION forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER results_immutable BEFORE UPDATE OR DELETE ON results
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE FUNCTION freeze_published_marks() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM attempts a JOIN exams e ON e.exam_id = a.exam_id
             WHERE a.attempt_id = OLD.attempt_id AND e.status = 'PUBLISHED') THEN
    RAISE EXCEPTION 'marks are frozen after results are published';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER answers_frozen_after_publish BEFORE UPDATE OR DELETE ON answers
  FOR EACH ROW EXECUTE FUNCTION freeze_published_marks();
