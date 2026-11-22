# Kolo

A Nigerian mobile banking app: send to any bank, Kolo-to-Kolo transfers, your own account number, PIN and SMS-code security, with savings, bills, Ajo and more on the way.

| Folder | What it is |
|---|---|
| `api/` + `server/` | The Kolo server, running on **Vercel** |
| `db/` | The database (tables, money ledger, money functions) for **Neon** Postgres |
| `mobile/` | The Android and iPhone app (Expo + React Native) |

Banking partner: **9PSB** (adapter in `server/bank/ninepsb.ts`, waiting for their API docs). Until it's connected, a built-in **test bank** is used and no real money moves.

## How the money stays safe

| Layer | What it does |
|---|---|
| Ledger | Money is stored in kobo (whole numbers). Every balance change writes an append-only ledger line, and the admin screen checks that balances always equal the ledger. |
| Server-only database | The app never touches the database. Everything goes through the Kolo API, which only ever returns your own data. |
| Server checks | Every transfer is checked on the server for PIN, SMS code, account-level limits, your own daily limit, frozen status and rate limits *before* money moves. A modified app can't skip them. |
| Sign-in | Phone number + SMS code. Sessions are random tokens kept in the phone's secure keychain; only their hash is stored. Signing a device out works instantly. New-device alerts. |
| PIN | PBKDF2 (310,000 rounds, per-user salt, server pepper). Never stored on the phone. 5 wrong tries lock PIN entry for 30 minutes. Easy PINs are rejected. |
| SMS codes | Needed for transfers of ₦50,000 and above, PIN changes, unfreezing, raising limits. Hashed, single-use, 5-minute expiry, 3 tries. |
| Transfers | Double-taps can't send twice. Money is parked while the bank works; failures are refunded automatically (fee included); stuck transfers are re-checked. |
| Phone | App lock with Face ID or PIN, screenshots blocked on Android, content hidden in the app switcher. |
| Emergency | One-tap freeze (no PIN, so it's fast). Unfreezing needs PIN + code. An admin hold can only be lifted by an admin. |

## Environment variables (Vercel → Project → Settings → Environment Variables)

| Name | Value |
|---|---|
| `DATABASE_URL` | Neon connection string (added automatically when Neon is connected) |
| `KOLO_ENV` | `sandbox` while testing, `production` when live |
| `BANK_PROVIDER` | `mock` (test bank) or `9psb` |
| `KYC_PROVIDER` | `mock` for now |
| `PIN_PEPPER` | a long random secret. **Keep a private copy**: if it changes, every PIN must be reset |
| `CRON_SECRET` | a random secret for the transfer checker |
| `MOCK_WEBHOOK_SECRET` | a random secret for test-bank webhooks |
| `ADMIN_PHONES` | your number(s) in 234… format, comma-separated. They get the Admin tab |
| `SMS_PROVIDER` | `log` for now (codes show on screen in test mode); `termii` for real SMS, plus `TERMII_API_KEY` and `TERMII_SENDER_ID` |

## Database
Run `db/001_core.sql` once on a fresh Neon database (Neon → SQL Editor). Check it worked at `https://YOUR-APP.vercel.app/api/health`.

## Checking stuck transfers
Vercel's free plan runs scheduled jobs once a day, so the checker in `vercel.json` runs daily, and a pending transfer is also re-checked whenever its owner opens it. For every-minute checks for free, create a job at **cron-job.org** that calls `https://YOUR-APP.vercel.app/api/cron/reconcile` every minute with the header `Authorization: Bearer YOUR_CRON_SECRET`. Or upgrade to Vercel Pro and change the schedule to `* * * * *`.

## The app (mobile/)
```bash
cd mobile
cp .env.example .env        # EXPO_PUBLIC_API_URL = your Vercel address
npm install
npx expo install --fix      # aligns every package to the Expo SDK
npx expo start              # scan the QR code with Expo Go
```
Without a computer, Expo's cloud build (EAS) can build an installable Android app straight from this repo.

## Testing with the test bank
- In test mode, sign-in and security codes are shown on screen (no SMS needed).
- Any 11-digit BVN or NIN not starting with 0 passes; starting with 0 fails.
- Account numbers ending in `0000` → "account not found".
- Account numbers ending in `9999` → the transfer stays pending until it's re-checked.
- Sending exactly **₦4,040** → the bank rejects it and you're refunded automatically.
- Admins can add test money from the Admin tab.

## Going live with 9PSB
1. Get 9PSB's partner API docs and sandbox credentials.
2. Fill in every `TODO(9psb)` in `server/bank/ninepsb.ts`.
3. Add `BANK_PROVIDER=9psb`, `NINEPSB_BASE_URL`, `NINEPSB_CLIENT_ID`, `NINEPSB_CLIENT_SECRET`, `NINEPSB_WEBHOOK_SECRET`.
4. Give 9PSB your webhook URL: `https://YOUR-APP.vercel.app/api/bank-webhook`
5. Add a real KYC provider, confirm the tier limits in `db/001_core.sql` with 9PSB, turn on real SMS, then set `KOLO_ENV=production` (the test bank and test deposits refuse to run in production).

## Roadmap
- **Phase 1 (this):** sign-in, BVN check, account number, bank and Kolo transfers, PIN, SMS codes, limits, freeze, devices, notifications, history, admin.
- **Phase 2:** airtime, data, electricity and TV, savings goals with interest, Break Kolo.
- **Phase 3:** Ajo circles, request and split, spending insights, Kolo points, Pidgin mode, push notifications.
