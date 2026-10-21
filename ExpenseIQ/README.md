# 💰 ExpenseIQ — Expense Tracker with Its Own Login, Live Sync and an AI Assistant

A full-stack personal-finance app with **hand-written login/logout**, per-user private data, live updates across tabs and devices, and a Gemini-powered assistant that answers questions about *your* expenses.

**No Firebase. No third-party login. No npm dependencies.** The whole backend is plain Node.js (built-in `http`, `crypto`, `fs`), and data is stored in a single JSON file.

---

## 🚀 Run it (2 minutes)

You need **Node.js 20.12 or newer** (<https://nodejs.org>, LTS version).

```bash
cd ExpenseIQ
npm start
```

Open **http://localhost:3000**, click **Create an account**, and start using it.
That's all — there is nothing to install and nothing to configure.

> Optional: add `GEMINI_API_KEY` (see below) to get AI-written answers. Without it, the assistant still replies using a summary computed from your data.

---

## ✨ Features

| Area | What you get |
|------|--------------|
| **Login (hand-written)** | Register, login, logout. Passwords hashed with salted **scrypt**; login kept in an **HttpOnly, SameSite=Strict cookie**; sessions stored server-side, so logout really ends the session |
| **Private data** | Each user only ever sees their own expenses, income, budgets and chat |
| **Live updates** | Change something in one tab/device → every other open tab/device updates by itself (Server-Sent Events) |
| **Offline-tolerant** | If the connection drops, changes are shown immediately, queued, and sent when it returns |
| **Dashboard** | Income, expenses, balance, budget, remaining, average per day, category charts, recent items |
| **Expenses / Income** | Add, edit, delete; search; category, month and date-range filters; sorting |
| **Budgets** | Monthly budget with progress bar and over-budget warning |
| **Reports** | 6/12-month trend vs budget, top spending days, statistics |
| **CSV** | Export, import (robust parser, duplicate-safe), budgets JSON export |
| **AI assistant** | Ask in plain English; chat history; typing indicator; timestamps; graceful fallback if the AI is down |
| **Migration** | Data saved by the old localStorage version is offered for import once, with no duplicates |

### How the AI stays trustworthy
1. The browser sends only your question. The server knows who you are from the login cookie.
2. The server loads **your** data and calculates totals, comparisons and the forecast in `server/finance.js`.
3. Gemini receives those calculated facts and is told to quote them, not calculate.
4. If Gemini fails, you still get a correct computed summary (clearly marked).

---

## 🗂 Project structure

```
ExpenseIQ/
├── server/
│   ├── index.js      # start-up
│   ├── app.js        # HTTP server: routing, security headers, CSRF check, rate limits, live stream
│   ├── handlers.js   # API logic: register/login/logout, data CRUD, import, chat
│   ├── auth.js       # password hashing (scrypt), session tokens, cookies, login throttle
│   ├── store.js      # JSON-file database (atomic writes), per-user data
│   ├── finance.js    # ALL financial arithmetic: totals, comparison, forecast
│   ├── gemini.js     # Gemini client (key kept in environment variable)
│   └── config.js     # environment → settings
├── public/           # frontend (vanilla HTML/CSS/JS — your original stack)
│   ├── index.html   css/style.css
│   └── js/ shared.js data.js ui.js charts.js chat.js auth.js app.js
├── tests/            # unit + integration tests, and e2e/ (browser tests)
├── data/             # created automatically — your users & expenses (git-ignored)
├── .env.example      # optional settings
├── .vscode/          # VS Code tasks, debug configs, extensions
└── docs/PROJECT_REPORT.md
```

---

## 🧑‍💻 VS Code

Open the folder in VS Code (`code .`).

| Want to… | Do this |
|---|---|
| Start the server | Terminal → `npm start` (or **F5** → "▶ Server + Chrome") |
| Auto-start on open | Allow automatic tasks when VS Code asks (task *Start dev server*) |
| Auto-restart when you edit code | `npm run dev` |
| Run tests | `Ctrl/Cmd+Shift+P → Tasks: Run Test Task` |

---

## ⚙️ Optional settings (`.env`)

Copy `.env.example` to `.env` only if you want to change something.

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | *(none)* | AI answers. Create a free key at <https://aistudio.google.com/apikey> |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Change if Google retires the name |
| `PORT` | `3000` | Port to listen on |
| `DATA_FILE` | `./data/expenseiq-data.json` | Where users/expenses are stored |
| `SESSION_DAYS` | `7` | How long a login lasts |
| `COOKIE_SECURE` | on in production | Cookies only over HTTPS |
| `TRUST_PROXY` | `0` | Set `1` behind a hosting proxy so rate limits see real IPs |
| `CHAT_RATE_LIMIT_PER_MIN` / `AUTH_RATE_LIMIT_PER_MIN` / `API_RATE_LIMIT_PER_MIN` | 10 / 20 / 240 | Rate limits |

Run `npm run check` to see what is configured. Secrets live only in environment variables — never in code.

---

## 🧪 Testing

```bash
npm test                          # 92 unit + integration tests (no setup needed)
npm install && npx playwright install chromium    # once, for browser tests
npm run test:e2e                  # 25 browser tests (real server, headless Chromium)
```

Covered: password hashing, login throttling, sessions & logout, cookie flags, CSRF checks, **cross-user isolation (including the AI)**, request validation, rate limits, live updates, restart persistence, file-store integrity, CSV edge cases, duplicate prevention, XSS escaping, offline queue, session expiry, responsive layout.

---

## ☁️ Deploying

This needs a host that runs a Node server **and keeps its disk** (the JSON file lives there): a VPS, Render/Railway/Fly with a **persistent disk/volume**, or a Raspberry Pi. Platforms with an ephemeral disk would lose data on every restart.

1. Upload the project (without `node_modules`/`data`/`.env`).
2. Build command: *(none)* · Start command: `npm start`
3. Environment: `NODE_ENV=production`, `TRUST_PROXY=1`, `GEMINI_API_KEY=…`, and `DATA_FILE=/path/on/the/persistent/disk/expenseiq-data.json`
4. Serve over **HTTPS** (production cookies are `Secure`, so login will not work over plain http — set `COOKIE_SECURE=0` only for testing).
5. Back up the data file regularly (just copy it).

---

## 🔐 Security summary

- **Passwords:** salted scrypt (never stored or logged in plain text); unknown-email and wrong-password look and take the same.
- **Sessions:** 256-bit random token in an HttpOnly + SameSite=Strict (+ Secure in production) cookie; only its SHA-256 hash is stored server-side; logout deletes it.
- **Brute force:** failed logins are throttled per IP+email and per email; auth endpoints are rate-limited.
- **CSRF:** SameSite=Strict, a required custom header, and a same-origin check on every state-changing request.
- **Isolation:** the user id comes only from the server-side session, never from the request.
- **Headers:** strict Content-Security-Policy (no inline scripts), nosniff, no framing, no-referrer; user text is HTML-escaped everywhere.
- **Limits:** small body limits, message length cap, per-user caps; no financial data or passwords in logs.
- **Secrets:** `.env` and `data/` are git-ignored.

### Honest limitations
- Storage is one JSON file: perfect for a project/demo or a handful of users, not for thousands.
- There is no "forgot password" email (it would need an email service). An admin can remove a user from the data file.
- Login throttling and rate limits live in memory and reset when the server restarts; run a single server instance.

---

## 🧯 Troubleshooting

| Symptom | Fix |
|---|---|
| Setup screen: "Could not reach the ExpenseIQ server" | Start the server with `npm start`, reload |
| Can't stay logged in after deploying | You are on plain http with `NODE_ENV=production` → use HTTPS (or `COOKIE_SECURE=0` for testing) |
| "Too many failed attempts" | Wait the shown minutes (login throttle) |
| Assistant shows ⚠️ + a summary | Gemini key missing/invalid or quota reached — numbers are still correct |
| Charts missing | Chart.js loads from a CDN; check your internet connection |
| `Data file … is not valid JSON` | The data file was edited/corrupted. Restore a backup (the server refuses to overwrite it) |
| Port already in use | Set `PORT=3001` |

## 📄 CSV format

```csv
date,category,amount,description
2026-10-05,Food,250.00,"Lunch, with friends"
```
Unknown categories become `Other`; invalid rows are reported and skipped; re-importing the same file adds nothing.
