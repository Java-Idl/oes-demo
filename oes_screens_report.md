# OES Demo — Screen Documentation Report
**Application:** ExamSecure · Online Examination System  
**URL:** http://localhost:8919  
**Captured:** 2026-09-25

---

## S1 – Login

![S1 Login Screen](C:/Users/java/.gemini/antigravity-ide/brain/133c2664-2220-4950-91e5-69885928b06e/s1_login_1790313783154.png)

**URL:** `http://localhost:8919/`

### Key UI Elements
| Element | Description |
|---|---|
| Branding | "ExamSecure" logo / header |
| Input: Email / Roll Number | Text field for username identification |
| Input: Password | Password field with "Show password" toggle |
| Sign In Button | Primary CTA to authenticate |
| Demo Accounts (collapsible) | Expandable section listing all role credentials |

### Demo Credentials Available
| Role | Username | Password |
|---|---|---|
| Student | `22CCE1001` | `Student@12345` |
| Student (Active Exam) | `22CCE1002` | `Student@12345` |
| Faculty | `priya@oes.local` | `Faculty@12345` |
| Admin | `admin@oes.local` | `Admin@12345` |

---

## S2 – Student Dashboard

![S2 Student Dashboard](C:/Users/java/.gemini/antigravity-ide/brain/133c2664-2220-4950-91e5-69885928b06e/s2_student_dashboard_1790313829193.png)

**URL:** `http://localhost:8919/student.html`  
**Logged in as:** S. Kavin (`22CCE1001`)

### Key UI Elements
| Element | Description |
|---|---|
| Top Navigation Bar | Student name, role badge, Logout button |
| Available Examinations Table | Lists exam name, date/time window, duration, total marks, and action |
| Exam Status Badges | Dynamic states: *Upcoming*, *Submitted*, *Missed*, *Result Published* |
| My Results Section | Shows published scores, letter grades (O, B+), and *Verified* integrity status |

---

## S3 – Exam Attempt

![S3 Exam Attempt](C:/Users/java/.gemini/antigravity-ide/brain/133c2664-2220-4950-91e5-69885928b06e/s3_exam_attempt_1790313928831.png)

**URL:** `http://localhost:8919/exam.html?id=8c283675-ff50-40b9-9c58-02e251fe8fa2`  
**Logged in as:** A. Arun (`22CCE1002`)

### Key UI Elements
| Element | Description |
|---|---|
| Countdown Timer | Live timer displayed prominently (e.g., `00:29:42`) |
| Question Area | Question text, marks per question, MCQ answer options |
| Navigation Controls | Previous · Mark for Review · Clear · Save & Next |
| Question Palette | Visual grid (1–5) with color-coded states: Answered / Marked / Not Answered |
| Submit Exam Button | Red CTA to finalize and submit the exam |

---

## S4 – Faculty Review & Publish Results

![S4 Faculty Review](C:/Users/java/.gemini/antigravity-ide/brain/133c2664-2220-4950-91e5-69885928b06e/s4_faculty_review_1790314069376.png)

**URL:** `http://localhost:8919/faculty-exam.html?id=8c283675-ff50-40b9-9c58-02e251fe8fa2`  
**Logged in as:** Dr. K. Priya (`priya@oes.local`)

### Key UI Elements
| Element | Description |
|---|---|
| Exam Summary | Total marks, total questions, question type breakdown |
| Answer Key Section | Correct answers highlighted for each question |
| Student Submissions Table | Lists students with: submission status (*Evaluated* / *In Progress*), timestamp, score, review link |
| Publish Results Button | Disabled while active sessions exist; enforces exam-window closure rule |

> [!NOTE]
> The **Publish Results** button is intentionally disabled while any student session is still *In Progress*. Results can only be published after all student sessions have ended.

---

## Recording

The full browser session recording is available here:

![Browser session recording](C:/Users/java/.gemini/antigravity-ide/brain/133c2664-2220-4950-91e5-69885928b06e/app_screenshots_capture_1790313733959.webp)
