/**
 * Bot KV storage. Loads the entire bot state from a single Supabase table
 * at the start of a request and writes back at the end. Mirrors the legacy
 * db.json layout so the ported bot logic can keep using the same shapes.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type AccountItem =
  | { email: string }
  | { phone: string; password: string }
  | { code: string }
  | Record<string, unknown>;

export interface AccountsData {
  account_types: Record<string, AccountItem[]>;
  prices: Record<string, number>;
}

export interface Session {
  state?: string;
  account_type?: string;
  quantity?: number;
  price?: number;
  available_count?: number;
  total_price?: number;
  transaction_id?: string | null;
  md5?: string | null;
  qr_sent_at?: number;
  photo_message_id?: number;
  qr_message_id?: number;
  started_at?: number;
  labels?: Record<string, string>;
  type_name?: string;
  accounts?: AccountItem[];
  broadcast_text?: string;
  broadcast_message_id?: number;
  broadcast_chat_id?: number;
  broadcast_use_copy?: boolean;
  [k: string]: unknown;
}

export interface KnownUser {
  first_name: string;
  last_name: string;
  username: string;
  first_seen: string;
}

export interface Purchase {
  user_id: number;
  account_type: string;
  quantity: number;
  total_price: number;
  accounts: AccountItem[];
  purchased_at: string;
}

export interface BotState {
  accounts: AccountsData;
  sessions: Record<string, Session>;
  settings: Record<string, string>;
  users: Record<string, KnownUser>;
  purchases: Purchase[];
}

let _sb: SupabaseClient | null = null;
function sb() {
  if (!_sb) {
    _sb = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
  }
  return _sb;
}

export async function loadState(): Promise<BotState> {
  const { data, error } = await sb()
    .from("bot_kv")
    .select("key,value")
    .in("key", ["accounts", "sessions", "settings", "users", "purchases"]);
  if (error) throw new Error(`loadState: ${error.message}`);
  const map = new Map<string, unknown>();
  for (const row of data ?? []) map.set(row.key as string, row.value);
  const accounts = (map.get("accounts") as AccountsData) ?? {
    account_types: {},
    prices: {},
  };
  return {
    accounts: {
      account_types: accounts.account_types ?? {},
      prices: accounts.prices ?? {},
    },
    sessions: (map.get("sessions") as Record<string, Session>) ?? {},
    settings: (map.get("settings") as Record<string, string>) ?? {},
    users: (map.get("users") as Record<string, KnownUser>) ?? {},
    purchases: (map.get("purchases") as Purchase[]) ?? [],
  };
}

export async function saveState(state: BotState): Promise<void> {
  const rows = [
    { key: "accounts", value: state.accounts },
    { key: "sessions", value: state.sessions },
    { key: "settings", value: state.settings },
    { key: "users", value: state.users },
    { key: "purchases", value: state.purchases },
  ].map((r) => ({ ...r, updated_at: new Date().toISOString() }));
  const { error } = await sb().from("bot_kv").upsert(rows, { onConflict: "key" });
  if (error) throw new Error(`saveState: ${error.message}`);
}
