
## Context & constraints

Your bot is 902 lines of Telegraf running in long-polling mode with:
- **File DB** (`db.json` via `fs`) — Workers have no filesystem.
- **In-memory state** (`user_sessions`, `_notified`, `_delivering`) — Workers don't keep state across requests.
- **setInterval payment watchdog** — Workers can't run long-lived loops.
- **`bot.launch()` polling** — incompatible with serverless.

So this isn't a 1-line `setWebhook` swap. We need to migrate storage and the watchdog too. Plan below keeps your bot logic byte-for-byte equivalent (same buttons, same flows, same Khmer copy), only changing how it's hosted.

## What I'll build

### 1. Storage migration (file → Supabase)
Create one key/value table that mirrors `db.json`:
```
bot_kv(key text primary key, value jsonb, updated_at timestamptz)
```
Keys: `accounts`, `sessions`, `settings`, `users`, `purchases`.

Helpers `loadAll()` / `saveAll()` read/write the whole snapshot at the start and end of each webhook request. Same shape as today, so the bot code that touches `accounts_data`, `user_sessions`, etc. stays unchanged.

### 2. Webhook endpoint
`src/routes/api/public/telegram/webhook.ts`
- Verifies Telegram's `X-Telegram-Bot-Api-Secret-Token` header (derived from `TELEGRAM_API_KEY`).
- Calls `loadAll()` → `bot.handleUpdate(update)` → `saveAll()`.
- Uses Telegraf in webhook mode (`new Telegraf(token)`, no `bot.launch()`).

### 3. Bot core module
`src/lib/telegram/bot.ts` — port of your entire `bot.js`:
- All commands, callbacks, admin menus, broadcast, exports, E-GetS channel handler.
- `fs`/`path`/`url` removed; `crypto` (Web Crypto compatible) kept.
- `QRCode` (pure JS) kept.
- `_notified` Set replaced with check against `known_users` (already persisted).
- `_delivering` lock replaced with `session.state === "delivering"` flag in DB.

### 4. Payment watchdog (setInterval → pg_cron)
`src/routes/api/public/telegram/watchdog.ts` does what `runPaymentWatchdog` did:
- Loads pending sessions, checks Cambo status, delivers or expires.
- Cron job runs every 1 minute (pg_cron minimum) hitting this endpoint. Note: that's slower than your current 5s polling — payment confirmation will take up to ~60s instead of ~5s. Users can still tap "✅ បានបង់ប្រាក់" for instant check.

### 5. Bot token & secrets
- Telegram bot is already connected; `TELEGRAM_API_KEY` (Lovable connection key, used via the connector gateway) is available — but Telegraf needs the **raw bot token**. I'll switch to direct Bot API calls (`https://api.telegram.org/bot<TOKEN>`) instead of the gateway, so we need your real `TELEGRAM_BOT_TOKEN` as a secret. I'll request it via secrets.
- `ADMIN_ID` — defaults to `5002402843` from your code; configurable via secret.
- `CAMBO_API_TOKEN` — already in your settings, stored in DB.

### 6. Setup steps I'll run
1. Create table + grants migration.
2. Request `TELEGRAM_BOT_TOKEN` secret.
3. Write bot module + webhook route + watchdog route.
4. Call `setWebhook` against `https://project--bedf53fa-ffa1-4853-8be5-954f796b3fa1-dev.lovable.app/api/public/telegram/webhook` with the secret_token.
5. Insert pg_cron job (1-min interval) hitting the watchdog route.
6. Verify with `/start`.

## Trade-offs / things to confirm

- **Watchdog polling drops 5s → 60s** (pg_cron min). The manual "បានបង់ប្រាក់" button still gives instant confirmation. Accept?
- **Per-request load+save of full DB**. Fine for your scale (a few hundred users, a few hundred coupons). If stock grows to 10k+ rows, we'd split into proper tables. OK for now?
- **Sequential broadcast** (50ms delay between sends) — runs inside one webhook request. Telegram webhook handlers should return quickly; a broadcast to 1000 users = ~50s, risks timeout. I'll move broadcast to a fire-and-forget background path (`ctx.waitUntil`-style) — sends complete after the webhook response.
- **`_notified` / `_delivering` in-memory sets** — replaced by DB checks. Slightly different semantics, but safer in serverless.
- **The bot's "Bot ready" startup ping to admin** is removed (no startup event in webhooks).

## Files to add

- `supabase/migrations/*_bot_kv.sql`
- `src/lib/telegram/storage.ts`
- `src/lib/telegram/bot.ts` (the ported logic)
- `src/routes/api/public/telegram/webhook.ts` (replace current 1-liner)
- `src/routes/api/public/telegram/watchdog.ts`

Confirm and I'll execute end-to-end (table → port → setWebhook → pg_cron → smoke test).
