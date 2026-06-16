/**
 * Thin Telegram Bot API wrapper that calls the Lovable connector gateway.
 * Replaces the small subset of telegraf we need.
 */

const GATEWAY_URL = "https://connector-gateway.lovable.dev/telegram";

function headers(extra: Record<string, string> = {}) {
  const lovable = process.env.LOVABLE_API_KEY;
  const tg = process.env.TELEGRAM_API_KEY;
  if (!lovable) throw new Error("LOVABLE_API_KEY is not configured");
  if (!tg) throw new Error("TELEGRAM_API_KEY is not configured");
  return {
    Authorization: `Bearer ${lovable}`,
    "X-Connection-Api-Key": tg,
    ...extra,
  };
}

async function call<T = any>(method: string, body: unknown): Promise<T> {
  const res = await fetch(`${GATEWAY_URL}/${method}`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* ignore */ }
  if (!res.ok || data?.ok === false) {
    const msg = data?.description || data?.error || text || `HTTP ${res.status}`;
    const err = new Error(`Telegram ${method} failed [${res.status}]: ${msg}`);
    (err as any).response = data;
    throw err;
  }
  return (data?.result ?? data) as T;
}

// ---- Inline keyboard / reply markup helpers ----
export type InlineButton =
  | { text: string; callback_data: string }
  | { text: string; url: string };
export type ReplyMarkup = any;

export const Markup = {
  inlineKeyboard(rows: InlineButton[][]): ReplyMarkup {
    return { inline_keyboard: rows };
  },
  button: {
    callback(text: string, callback_data: string): InlineButton {
      return { text, callback_data };
    },
    url(text: string, url: string): InlineButton {
      return { text, url };
    },
  },
  keyboard(rows: (string | { text: string })[][]) {
    const keyboard = rows.map((row) =>
      row.map((c) => (typeof c === "string" ? { text: c } : c)),
    );
    return {
      reply_markup: { keyboard, resize_keyboard: true, is_persistent: true },
    } as { reply_markup: ReplyMarkup };
  },
  removeKeyboard() {
    return { reply_markup: { remove_keyboard: true } };
  },
};

// ---- API methods ----
export interface SentMessage { message_id: number; chat: { id: number } }

export async function sendMessage(
  chat_id: number | string,
  text: string,
  extra: Record<string, any> = {},
): Promise<SentMessage | null> {
  try {
    return await call<SentMessage>("sendMessage", {
      chat_id,
      text,
      parse_mode: "HTML",
      ...flattenExtra(extra),
    });
  } catch (e) {
    console.warn(`[tg] sendMessage(${chat_id}):`, (e as Error).message);
    return null;
  }
}

export async function editMessageText(
  chat_id: number | string,
  message_id: number,
  text: string,
  extra: Record<string, any> = {},
): Promise<boolean> {
  try {
    await call("editMessageText", {
      chat_id,
      message_id,
      text,
      parse_mode: "HTML",
      ...flattenExtra(extra),
    });
    return true;
  } catch {
    return false;
  }
}

export async function deleteMessage(chat_id: number | string, message_id: number) {
  if (!message_id) return;
  try { await call("deleteMessage", { chat_id, message_id }); } catch { /* ignore */ }
}

export async function answerCallbackQuery(
  callback_query_id: string,
  text?: string,
  show_alert = false,
) {
  try {
    await call("answerCallbackQuery", { callback_query_id, text, show_alert });
  } catch { /* ignore */ }
}

/**
 * Send a photo by uploading raw bytes (multipart/form-data through the gateway).
 */
export async function sendPhoto(
  chat_id: number | string,
  photo: Uint8Array,
  extra: Record<string, any> = {},
): Promise<SentMessage | null> {
  try {
    const form = new FormData();
    form.append("chat_id", String(chat_id));
    form.append("parse_mode", "HTML");
    const flat = flattenExtra(extra);
    for (const [k, v] of Object.entries(flat)) {
      form.append(k, typeof v === "string" ? v : JSON.stringify(v));
    }
    form.append("photo", new Blob([photo as BlobPart], { type: "image/png" }), "qr.png");
    const res = await fetch(`${GATEWAY_URL}/sendPhoto`, {
      method: "POST",
      headers: headers(),
      body: form,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.ok === false) {
      console.warn("[tg] sendPhoto failed:", res.status, JSON.stringify(data));
      return null;
    }
    return data.result as SentMessage;
  } catch (e) {
    console.warn(`[tg] sendPhoto(${chat_id}):`, (e as Error).message);
    return null;
  }
}

export async function sendDocument(
  chat_id: number | string,
  bytes: Uint8Array,
  filename: string,
  caption = "",
): Promise<SentMessage | null> {
  try {
    const form = new FormData();
    form.append("chat_id", String(chat_id));
    if (caption) {
      form.append("caption", caption);
      form.append("parse_mode", "HTML");
    }
    form.append(
      "document",
      new Blob([bytes as BlobPart], { type: "application/octet-stream" }),
      filename,
    );
    const res = await fetch(`${GATEWAY_URL}/sendDocument`, {
      method: "POST",
      headers: headers(),
      body: form,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.ok === false) {
      console.warn("[tg] sendDocument failed:", res.status, JSON.stringify(data));
      return null;
    }
    return data.result as SentMessage;
  } catch (e) {
    console.warn(`[tg] sendDocument(${chat_id}):`, (e as Error).message);
    return null;
  }
}

export async function getMe() {
  return call("getMe", {});
}

export async function setWebhook(url: string, secret_token: string) {
  return call("setWebhook", {
    url,
    secret_token,
    allowed_updates: ["message", "edited_message", "callback_query", "channel_post"],
  });
}

// Convert Markup helper outputs into flat top-level fields.
function flattenExtra(extra: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(extra)) {
    if (k === "reply_markup" || k === "parse_mode" || k === "caption") {
      out[k] = v;
    } else if (v && typeof v === "object" && "reply_markup" in v) {
      out.reply_markup = (v as any).reply_markup;
    } else {
      out[k] = v;
    }
  }
  return out;
}
