# CivicPulse — local setup

## 1. Prerequisites
- Node.js 18+ installed (check with `node -v`)

## 2. Install & run
```bash
cd civicpulse
npm install
npm start
```
You should see:
```
CivicPulse server running at http://localhost:3000
```

## 3. Set up guaranteed demo logins (recommended before a presentation)
Run this once, after `npm install`:
```bash
node reset-demo-users.js
```
It prints (and sets) working credentials for all three roles:

| Role | Email | Password |
|---|---|---|
| citizen | citizen@civicpulse.gov.in | Citizen@123 |
| department | department@civicpulse.gov.in | Dept@123 |
| admin | admin@civicpulse.gov.in | Admin@123 |

It also resets the original seeded account (priyanshubhatta2007@gmail.com) to
password `Citizen@123`, so that exact user still works too. Run this script
again any time you want to reset back to these known passwords — safe to
re-run as often as you like, including right before you go on stage.

## 4. Open it
Go to **http://localhost:3000** in your browser and log in with one of the
accounts above, or click "Create an account" to register your own.

- Log in as **admin** to see Contractor Finance + all Feedback.
- Log in as **department** to manage report status/assignment + see Feedback.
- Log in as **citizen** to submit reports/feedback only.

## What the backend does
- Sessions via `express-session` (cookie-based, 7-day expiry).
- Passwords hashed with bcrypt, never sent to the client.
- `POST /api/reports` accepts multipart form data (photo + voice note),
  auto-tags **severity** (keyword heuristic) and **department** (category
  lookup) server-side so the client can't spoof either.
- Duplicate detection: any new report within ~75m of an existing
  unresolved report in the same category gets flagged (`duplicateOf`).
- Role enforcement happens **server-side**, not just by hiding UI:
  - `/api/feedback` (GET) → 403 for citizens.
  - `/api/reports/:id/status` and `/assign-contractor` → department/admin only.
  - `/api/contractors` strips finance fields unless you're admin.
  - `/api/contractors/:id/finance` (PATCH) → admin only.
- Uploaded photos/voice notes are saved to `uploads/` and served at `/uploads/...`.

## Notes / things to know
- This is a local dev setup: the JSON file (`db.json`) is not safe for
  concurrent production writes, and the session secret in `server.js` should
  be replaced with a real secret (e.g. via an environment variable) before
  deploying anywhere public.
- The Status Board currently shows every reporter's mobile number and full
  address to **all** signed-in users, including other citizens — that's how
  the existing frontend was built. If you want that restricted to
  department/admin only, say the word and I'll adjust the API + UI.
