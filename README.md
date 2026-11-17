# Kolo

A Nigerian mobile banking app: send to any bank, Kolo-to-Kolo transfers, account numbers, PIN and SMS-code security, with savings, bills, Ajo and more on the way.

- **mobile/**: the Android and iPhone app (Expo + React Native)
- **supabase/**: the database, the money ledger, and server functions
- Banking partner: **9PSB** (adapter in `supabase/functions/_shared/bank/ninepsb.ts`, waiting for their API docs). Until it's connected, a built-in **test bank** is used and no real money moves.

## How the money stays safe

| Layer | What it does |
|---|---|
| Ledger | Every naira is stored in kobo (whole numbers). Each balance change writes an append-only ledger line; the admin screen checks that balances always equal the ledger. |
| Locked-down database | The app can only *read* its own data. Balances can only change through SQL functions that the app is not allowed to call. Tested: a user editing their balance or reading another user's data gets nothing. |
| Server checks | Every transfer goes through the `api` function, which checks the PIN, the one-time SMS code, tier limits, the user's own daily limit, frozen status and rate limits *before* moving money. A modified app can't skip them. |
| PIN | Hashed with PBKDF2 (310,000 rounds, per-user salt, server pepper). Never stored on the phone. 5 wrong tries lock PIN entry for 30 minutes. Easy PINs are rejected. |
| SMS codes | Required for transfers of ₦50,000 and above, PIN changes, unfreezing and raising limits. Hashed, single-use, expire in 5 minutes, 3 tries. |
| Transfers | Idempotency keys stop double-sends. Money is parked while the bank processes; if the bank fails it's refunded automatically, and a reconcile job checks stuck transfers every minute. |
| Phone | Session in the secure keychain, app lock with Face ID or PIN after 30s away or 2 min idle, screenshots blocked on Android, content hidden in the app switcher. New-device alerts. |
| Emergency | One-tap freeze (no PIN needed, so it's fast). Unfreezing needs PIN + code. Admin holds can only be lifted by an admin. |

## Setup

### 1. Supabase project
1. Create a project at supabase.com.
2. Install the Supabase CLI, then from this folder:
   ```bash
   supabase link --project-ref YOUR_PROJECT_REF
   supabase db push
   ```
3. Set the server secrets (never put these in the app):
   ```bash
   supabase secrets set KOLO_ENV=sandbox BANK_PROVIDER=mock KYC_PROVIDER=mock \
     PIN_PEPPER=$(openssl rand -hex 32) CRON_SECRET=$(openssl rand -hex 24) MOCK_WEBHOOK_SECRET=$(openssl rand -hex 24)
   ```
   Keep a private copy of `PIN_PEPPER`. If it's lost, every PIN has to be reset.
4. Deploy the functions:
   ```bash
   supabase functions deploy api
   supabase functions deploy bank-webhook --no-verify-jwt
   supabase functions deploy reconcile --no-verify-jwt
   ```
5. Run the reconcile job every minute (SQL editor; enable the `pg_cron` and `pg_net` extensions first):
   ```sql
   select cron.schedule('kolo-reconcile', '* * * * *', $$
     select net.http_post(
       url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/reconcile',
       headers := jsonb_build_object('x-cron-secret', 'YOUR_CRON_SECRET', 'Content-Type', 'application/json'),
       body := '{}'::jsonb)
   $$);
   ```

### 2. Phone sign-in
Supabase → Authentication → Providers → Phone: turn it on and connect an SMS provider. While testing, add **test phone numbers** with fixed codes there, so no SMS is needed.

For the in-app security codes, set `SMS_PROVIDER=termii` plus `TERMII_API_KEY` and `TERMII_SENDER_ID` when you're ready for real texts. Until then, codes are shown on screen in test mode.

### 3. Run the app
```bash
cd mobile
cp .env.example .env        # paste your project URL and anon key
npm install
npx expo install --fix      # aligns every package to the Expo SDK
npx expo start              # scan the QR code with Expo Go
```
Face ID and screenshot blocking need a development build (`npx expo run:android` / `run:ios`), not Expo Go.

### 4. Make yourself admin
Sign up in the app first, then in the SQL editor:
```sql
update profiles set is_admin = true where phone = '2348012345678';
```
The **Admin** tab appears: overview, ledger health, pending transfers with requery, customer search and holds, and **test deposits** (test mode only) to fund accounts.

## Testing with the test bank
- Any 11-digit BVN or NIN that doesn't start with 0 passes; starting with 0 fails.
- Account numbers ending in `0000` → "account not found".
- Account numbers ending in `9999` → transfer stays pending, then the reconcile job settles it.
- Sending exactly **₦4,040** → the bank rejects it and you're refunded automatically.

## Going live with 9PSB
1. Get 9PSB's partner API docs and sandbox credentials.
2. Fill in every `TODO(9psb)` in `supabase/functions/_shared/bank/ninepsb.ts`.
3. `supabase secrets set BANK_PROVIDER=9psb NINEPSB_BASE_URL=... NINEPSB_CLIENT_ID=... NINEPSB_CLIENT_SECRET=... NINEPSB_WEBHOOK_SECRET=...`
4. Give 9PSB your webhook URL: `https://YOUR_PROJECT_REF.supabase.co/functions/v1/bank-webhook`
5. Add a real KYC provider for BVN/NIN checks, confirm the tier limits in the migration with 9PSB, then set `KOLO_ENV=production` (the test bank and test deposits refuse to run in production).

## Roadmap
- **Phase 1 (this):** sign-up, BVN check, account number, bank and Kolo transfers, PIN, SMS codes, limits, freeze, devices, notifications, history, admin.
- **Phase 2:** airtime, data, electricity and TV, savings goals with interest, Break Kolo.
- **Phase 3:** Ajo circles, request and split, spending insights, Kolo points, Pidgin mode, push notifications.
