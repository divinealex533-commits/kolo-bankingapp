# Single-file functions for the Supabase website

Each file here is a complete edge function with the shared code built in, so it can be pasted into
Supabase → Edge Functions → Deploy a new function → Via editor (no command line needed).

| Function name | File | Verify JWT |
|---|---|---|
| `api` | api.ts | ON |
| `bank-webhook` | bank-webhook.ts | OFF |
| `reconcile` | reconcile.ts | OFF |

These are generated from `supabase/functions/`. After changing the source, regenerate them with:
`npx esbuild supabase/functions/NAME/index.ts --bundle --format=esm --platform=neutral --target=es2022 --external:'npm:*' --outfile=supabase/paste/NAME.ts`
