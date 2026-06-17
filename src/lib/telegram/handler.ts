/**
 * Bot handler — port of bot.js to a stateless webhook model.
 * Each incoming update calls `handleUpdate(update)` which loads state,
 * runs the handlers, then persists state.
 */
import crypto from "crypto";
// qrcode is loaded lazily inside generatePlainQR to keep the worker module load light
import {
  loadState,
  saveState,
  type AccountItem,
  type BotState,
  type Session,
} from "./storage";
import {
  Markup,
  answerCallbackQuery,
  deleteMessage,
  editMessageText,
  sendDocument,
  sendMessage,
  sendPhoto,
} from "./tg";

// ---------- constants ----------
const ADMIN_ID = Number(process.env.ADMIN_ID || "5002402843");
const CAMBO_BASE = "https://bakong.cambo-kh.com/api/v1";
const PAYMENT_TIMEOUT_SEC = 60;
export const PAYMENT_POLL_INTERVAL = 5;

const KH_TZ = "Asia/Phnom_Penh";
const nowKH = () =>
  new Date().toLocaleString("sv-SE", { timeZone: KH_TZ }).replace("T", " ") + " +07";
const nowKHFile = () =>
  new Date()
    .toLocaleString("sv-SE", { timeZone: KH_TZ })
    .replace(/[-: ]/g, "")
    .slice(0, 14);
const fmtKH = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString("sv-SE", { timeZone: KH_TZ }).replace("T", " ") +
      " +07"
    : "—";

const BTN_ADD_ACCOUNT = "➕ បន្ថែម គូប៉ុង";
const BTN_DELETE_TYPE = "🗑 លុបប្រភេទ";
const BTN_STOCK = "📦 ស្តុក គូប៉ុង";
const BTN_USERS = "👥 អ្នកប្រើប្រាស់";
const BTN_BUYERS = "📋 របាយការណ៍ទិញ";
const BTN_KHPAY = "💰 KhPay API";
const BTN_CHANNEL = "📢 Channel ID";
const BTN_ADMINS = "👑 គ្រប់គ្រង Admin";
const BTN_MAINTENANCE = "🛠 Maintenance Mode";
const BTN_BROADCAST = "📢 ផ្សាយព័ត៌មាន";
const BTN_BACK_SETTINGS = "⬅️";
const BTN_KHPAY_KEY_EDIT = "✏️ ប្តូរ KhPay API Key";
const BTN_KHPAY_INFO = "📊 ព័ត៌មាន KhPay";
const BTN_CHANNEL_EDIT = "✏️ ប្តូរ Channel ID";
const BTN_CHANNEL_CLEAR = "🗑 លុប Channel ID";
const BTN_ADMIN_ADD = "➕ បន្ថែម Admin";
const BTN_ADMIN_REMOVE = "➖ ដក Admin";
const BTN_MAINT_ON = "🔴 បិទ Bot";
const BTN_MAINT_OFF = "🟢 បើក Bot";
const BTN_CANCEL_INPUT = "🚫 បោះបង់";
const BTN_DELETE_CONFIRM = "✅ បញ្ជាក់លុប";
const BTN_DELETE_CANCEL = "🚫 បោះបង់ការលុប";
const BTN_BROADCAST_CONFIRM = "✅ បញ្ជាក់ផ្សាយ";
const BTN_BROADCAST_CANCEL = "🚫 បោះបង់ការផ្សាយ";
const ADMIN_SETTINGS_BTN = "/settings";

const ADMIN_BUTTON_LABELS = new Set([
  BTN_ADD_ACCOUNT, BTN_DELETE_TYPE, BTN_STOCK, BTN_USERS, BTN_BUYERS,
  BTN_KHPAY, BTN_CHANNEL, BTN_ADMINS, BTN_MAINTENANCE, BTN_BROADCAST,
  BTN_BACK_SETTINGS, BTN_KHPAY_KEY_EDIT, BTN_KHPAY_INFO,
  BTN_CHANNEL_EDIT, BTN_CHANNEL_CLEAR, BTN_ADMIN_ADD, BTN_ADMIN_REMOVE,
  BTN_MAINT_ON, BTN_MAINT_OFF, BTN_CANCEL_INPUT,
  BTN_DELETE_CONFIRM, BTN_DELETE_CANCEL, BTN_BROADCAST_CONFIRM, BTN_BROADCAST_CANCEL,
  ADMIN_SETTINGS_BTN,
]);

const MAIN_KB = Markup.keyboard([["💵 ទិញគូប៉ុង"]]);
const ADMIN_KB = Markup.keyboard([[ADMIN_SETTINGS_BTN]]);
const ADMIN_SETTINGS_KB = {
  reply_markup: {
    keyboard: [
      [{ text: BTN_ADD_ACCOUNT }, { text: BTN_DELETE_TYPE }],
      [{ text: BTN_STOCK }, { text: BTN_BUYERS }],
      [{ text: BTN_USERS }, { text: BTN_KHPAY }],
      [{ text: BTN_CHANNEL }, { text: BTN_ADMINS }],
      [{ text: BTN_BROADCAST }, { text: BTN_MAINTENANCE }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  },
};
const CANCEL_INPUT_KB = Markup.keyboard([[BTN_CANCEL_INPUT]]);
const ADD_ACCOUNT_KB = Markup.keyboard([[BTN_BACK_SETTINGS]]);
const BACK_SETTINGS_KB = Markup.keyboard([[BTN_BACK_SETTINGS]]);
const KHPAY_SUBMENU_KB = Markup.keyboard([
  [BTN_KHPAY_KEY_EDIT, BTN_KHPAY_INFO],
  [BTN_BACK_SETTINGS],
]);
const CHANNEL_SUBMENU_KB = Markup.keyboard([
  [BTN_CHANNEL_EDIT, BTN_CHANNEL_CLEAR],
  [BTN_BACK_SETTINGS],
]);
const ADMINS_SUBMENU_KB = Markup.keyboard([
  [BTN_ADMIN_ADD, BTN_ADMIN_REMOVE],
  [BTN_BACK_SETTINGS],
]);
const MAINTENANCE_SUBMENU_KB = Markup.keyboard([
  [BTN_MAINT_ON, BTN_MAINT_OFF],
  [BTN_BACK_SETTINGS],
]);
const BROADCAST_CONFIRM_KB = Markup.keyboard([
  [BTN_BROADCAST_CONFIRM],
  [BTN_BROADCAST_CANCEL],
]);
const CHECK_PAYMENT_INLINE = {
  reply_markup: Markup.inlineKeyboard([[
    Markup.button.callback("🚫 បោះបង់", "cancel_purchase"),
    Markup.button.callback("✅ បានបង់ប្រាក់", "check_payment"),
  ]]),
};

// ---------- shared mutable cursor over the loaded state ----------
interface Env {
  state: BotState;
  /** Extra admin IDs derived from settings on load. */
  extraAdmins: Set<number>;
  /** Channel ID derived from settings. */
  channelId: string;
  /** Cambo token from settings. */
  camboToken: string;
  /** Maintenance flag from settings. */
  maintenance: boolean;
}

function envFromState(state: BotState): Env {
  let extras = new Set<number>();
  const ea = state.settings.EXTRA_ADMIN_IDS;
  if (ea) {
    try {
      extras = new Set<number>(JSON.parse(ea).map((n: any) => Number(n)));
    } catch { /* ignore */ }
  }
  return {
    state,
    extraAdmins: extras,
    channelId: state.settings.TELEGRAM_CHANNEL_ID || process.env.CHANNEL_ID || "",
    camboToken:
      state.settings.CAMBO_API_TOKEN || process.env.CAMBO_API_TOKEN || "",
    maintenance: state.settings.MAINTENANCE_MODE === "true",
  };
}

function persistEnv(env: Env) {
  env.state.settings.EXTRA_ADMIN_IDS = JSON.stringify([...env.extraAdmins]);
  env.state.settings.TELEGRAM_CHANNEL_ID = env.channelId;
  env.state.settings.CAMBO_API_TOKEN = env.camboToken;
  env.state.settings.MAINTENANCE_MODE = env.maintenance ? "true" : "false";
}

const isAdmin = (env: Env, uid: number) =>
  uid === ADMIN_ID || env.extraAdmins.has(uid);

const mainKb = (env: Env, uid: number) =>
  isAdmin(env, uid) ? ADMIN_KB : Markup.removeKeyboard();

// ---------- formatting helpers ----------
const esc = (s: unknown) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const typeCallbackId = (at: string) =>
  crypto.createHash("sha1").update(at).digest("hex").slice(0, 12);

const typeFromCbId = (env: Env, cid: string) =>
  Object.keys(env.state.accounts.account_types).find(
    (t) => typeCallbackId(t) === cid,
  ) ?? null;

const shortLabel = (t: string, n = 36) => {
  const c = t.trim();
  return c.length <= n ? c : c.slice(0, n - 1) + "…";
};

function formatAccount(acc: AccountItem): string {
  if (typeof acc === "string") return acc;
  const a = acc as any;
  if (a.email) return a.email;
  if (a.phone) return `${a.phone} | ${a.password || ""}`;
  if (a.code) return a.code;
  return JSON.stringify(acc);
}

// ---------- Cambo / KhPay ----------
async function camboRequest(env: Env, params: Record<string, string | number>) {
  const qs = new URLSearchParams({
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    api_token: env.camboToken,
  }).toString();
  const res = await fetch(`${CAMBO_BASE}/?${qs}`, {
    signal: AbortSignal.timeout(12000),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { success: false, error: text };
  }
}

async function generatePlainQR(qr_string: string): Promise<Uint8Array> {
  // Cloudflare Worker–safe: fetch a PNG from a public QR service.
  const url =
    "https://api.qrserver.com/v1/create-qr-code/?size=400x400&margin=12&ecc=M&data=" +
    encodeURIComponent(qr_string);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`QR service HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function createKhpayPayment(env: Env, amount: number) {
  try {
    const res = await camboRequest(env, { type: "generate_qr", amount });
    if (res.status !== "success" || !res.data) {
      return {
        imgBuffer: null as Uint8Array | null,
        transaction_id: null as string | null,
        md5: null as string | null,
        error: res.message || res.error || "API error",
      };
    }
    const d = res.data;
    const md5 = d.md5 || null;
    const qr_string = d.qr || "";
    const imgUrl = d.Url_qr_code || null;
    let imgBuffer: Uint8Array | null = null;
    if (imgUrl) {
      try {
        const r = await fetch(imgUrl, { signal: AbortSignal.timeout(10000) });
        if (r.ok) imgBuffer = new Uint8Array(await r.arrayBuffer());
        else throw new Error(`HTTP ${r.status}`);
      } catch {
        imgBuffer = await generatePlainQR(qr_string);
      }
    } else if (qr_string) {
      imgBuffer = await generatePlainQR(qr_string);
    } else {
      return { imgBuffer: null, transaction_id: null, md5: null, error: "No QR data returned" };
    }
    return { imgBuffer, transaction_id: md5, md5, error: null as string | null };
  } catch (e) {
    return {
      imgBuffer: null,
      transaction_id: null,
      md5: null,
      error: (e as Error).message,
    };
  }
}

export async function checkKhpayStatus(
  env: Env,
  transaction_id: string,
  md5: string | null = null,
) {
  try {
    const checkMd5 = md5 || transaction_id;
    const data = await camboRequest(env, { type: "check_md5", md5: checkMd5 });
    const status = String(data?.status ?? "").toLowerCase();
    const isPaid =
      status === "paid" || status === "success" || status === "completed";
    return { paid: isPaid, status: status || "pending", data };
  } catch (e) {
    console.warn("[WARN] checkKhpayStatus:", (e as Error).message);
    return { paid: false, status: "error", data: null };
  }
}

// ---------- screens ----------
async function notifyAdminNewUser(env: Env, user: any) {
  const uid = Number(user.id);
  if (uid === ADMIN_ID || env.state.users[String(uid)]) return;
  env.state.users[String(uid)] = {
    first_name: user.first_name || "",
    last_name: user.last_name || "",
    username: user.username || "",
    first_seen: new Date().toISOString(),
  };
  const full = [user.first_name, user.last_name].filter(Boolean).join(" ") || "N/A";
  const uname = user.username ? `@${user.username}` : "—";
  await sendMessage(
    ADMIN_ID,
    `🆕 <b>អ្នកប្រើប្រាស់ថ្មី!</b>\n\n👤 ឈ្មោះ: ${esc(full)}\n🔖 Username: ${esc(uname)}\n🪪 ID: <code>${uid}</code>`,
  );
}

async function showAccountSelection(env: Env, chatId: number, editMsgId: number | null = null) {
  const available = Object.entries(env.state.accounts.account_types)
    .filter(([, v]) => v.length > 0)
    .map(([at, v]) => ({ at, count: v.length }));
  const text = "<b>សូមជ្រើសរើសគូប៉ុងដើម្បីទិញ៖</b>";
  const emptyText = "<i>សូមអភ័យទោស អស់ពីស្តុក 🪤</i>";
  if (!available.length) {
    if (editMsgId) {
      const ok = await editMessageText(chatId, editMsgId, emptyText);
      if (ok) return;
    }
    await sendMessage(chatId, emptyText);
    return;
  }
  const rows = available.map(({ at, count }) => [
    Markup.button.callback(`${at} – មានក្នុងស្តុក ${count}`, `buy:${typeCallbackId(at)}`),
  ]);
  if (editMsgId) {
    const ok = await editMessageText(chatId, editMsgId, text, {
      reply_markup: Markup.inlineKeyboard(rows),
    });
    if (ok) return;
  }
  await sendMessage(chatId, text, { reply_markup: Markup.inlineKeyboard(rows) });
}

async function sendAdminSettingsMenu(chatId: number) {
  await sendMessage(
    chatId,
    "<b>⚙️ ការកំណត់ Admin</b>\n\nសូមជ្រើសរើសប្រតិបត្តិការខាងក្រោម៖",
    ADMIN_SETTINGS_KB,
  );
}

async function startPaymentForSession(
  env: Env,
  chatId: number,
  userId: number,
  session: Session,
  cbq?: { id: string },
): Promise<boolean> {
  const { account_type, quantity } = session;
  const pool = env.state.accounts.account_types[account_type!] ?? [];
  if (pool.length < (quantity ?? 0)) {
    if (cbq)
      await answerCallbackQuery(
        cbq.id,
        `សូមអភ័យទោស! មានត្រឹមតែ ${pool.length} គូប៉ុង នៅក្នុងស្តុក`,
        true,
      );
    delete env.state.sessions[String(userId)];
    return false;
  }
  if (cbq) await answerCallbackQuery(cbq.id, "កំពុងបង្កើត QR...");
  session.state = "payment_pending";
  const { imgBuffer, transaction_id, md5, error } = await createKhpayPayment(
    env,
    session.total_price!,
  );
  if (!imgBuffer || !transaction_id) {
    if (isAdmin(env, userId)) {
      await sendMessage(
        chatId,
        `❌ <b>QR បរាជ័យ (Admin Debug):</b>\n<code>${esc(String(error))}</code>`,
      );
    } else {
      await sendMessage(
        chatId,
        "❌ <b>មានបញ្ហាក្នុងការបង្កើត QR Code</b>\n\nសូមព្យាយាមម្ដងទៀត។",
      );
      await sendMessage(
        ADMIN_ID,
        `⚠️ QR Error (user ${userId}): <code>${esc(String(error))}</code>`,
      );
    }
    delete env.state.sessions[String(userId)];
    return false;
  }
  session.transaction_id = transaction_id;
  session.md5 = md5 ?? null;
  session.qr_sent_at = Date.now();
  const photoMsg = await sendPhoto(chatId, imgBuffer, CHECK_PAYMENT_INLINE);
  if (photoMsg) {
    session.photo_message_id = photoMsg.message_id;
    session.qr_message_id = photoMsg.message_id;
  }
  env.state.sessions[String(userId)] = session;
  console.log(
    `[INFO] KhPay QR sent to user ${userId}: $${session.total_price}, TxnID: ${transaction_id}`,
  );
  return true;
}

export async function deliverAccounts(
  env: Env,
  chatId: number,
  userId: number,
  session: Session,
  paymentData: any = null,
) {
  const account_type = session.account_type!;
  const quantity = session.quantity!;
  for (const k of ["photo_message_id", "qr_message_id"] as const) {
    if (session[k]) deleteMessage(chatId, session[k] as number);
  }
  let delivered: AccountItem[] | null = null;
  const pool = env.state.accounts.account_types[account_type] ?? [];
  if (pool.length >= quantity) {
    delivered = pool.slice(0, quantity);
    env.state.accounts.account_types[account_type] = pool.slice(quantity);
  }
  delete env.state.sessions[String(userId)];
  if (!delivered) {
    await sendMessage(
      chatId,
      `❌ <b>មានបញ្ហា!</b>\n\nគ្មាន គូប៉ុង ប្រភេទ ${esc(account_type)} ក្នុងស្តុក។`,
    );
    return;
  }
  env.state.purchases.push({
    user_id: userId,
    account_type,
    quantity,
    total_price: session.total_price!,
    accounts: delivered,
    purchased_at: new Date().toISOString(),
  });
  for (let i = 0; i < delivered.length; i++) {
    const acc = delivered[i];
    const isLast = i === delivered.length - 1;
    const msg = `🎉 <b>ការទិញបានបញ្ជាក់ដោយជោគជ័យ</b>\n\nគូប៉ុងរបស់អ្នក៖ 👇\n\n<code>${esc(formatAccount(acc))}</code>\n\n<i>សូមអរគុណសម្រាប់ការទិញ 🙏</i>`;
    await sendMessage(chatId, msg, isLast ? mainKb(env, userId) : {});
  }
  try {
    const pd = paymentData || {};
    const now = nowKH();
    const fromAcc = pd.fromAccountId || pd.hash || "N/A";
    const memo = pd.memo || "គ្មាន";
    const ref = pd.externalRef || pd.transactionId || pd.md5 || "N/A";
    const adminMsg =
      "🎉 <b>ទទួលបានការបង់ប្រាក់ជោគជ័យ</b>\n" +
      "━━━━━━━━━━━━━━━━━━━\n" +
      `🆔 <b>អ្នកទិញ(ID):</b> ${userId}\n` +
      `📦 <b>ប្រភេទ:</b> ${esc(account_type)} × ${quantity}\n` +
      `💵 <b>ទឹកប្រាក់:</b> $${session.total_price}\n` +
      `👤 <b>ពីធនាគារ:</b> <code>${esc(fromAcc)}</code>\n` +
      `📝 <b>ចំណាំ:</b> ${esc(memo)}\n` +
      `🧾 <b>លេខយោង:</b> <code>${esc(ref)}</code>\n` +
      `⏰ <b>ម៉ោង:</b> ${now}`;
    await sendMessage(ADMIN_ID, adminMsg);
    if (env.channelId && String(env.channelId) !== String(ADMIN_ID)) {
      await sendMessage(env.channelId, adminMsg);
    }
  } catch (e) {
    console.warn("[WARN] admin payment notify:", (e as Error).message);
  }
  console.log(`[INFO] Delivered ${quantity}× ${account_type} to user ${userId}`);
}

// ---------- handlers ----------

async function handleCommand(env: Env, msg: any) {
  const text: string = msg.text;
  const uid: number = msg.from.id;
  const chatId: number = msg.chat.id;

  if (text === "/settings") {
    if (!isAdmin(env, uid)) return;
    const sess = env.state.sessions[String(uid)] ?? {};
    if (String(sess.state || "").startsWith("admin_input:")) {
      delete env.state.sessions[String(uid)];
    }
    return sendAdminSettingsMenu(chatId);
  }
  if (text === "/start" || text.startsWith("/start ")) {
    await notifyAdminNewUser(env, msg.from);
    if (env.maintenance && !isAdmin(env, uid)) {
      return sendMessage(chatId, "🔧 <b>Bot កំពុង Update សូមរង់ចាំមួយភ្លែត...</b>");
    }
    const sess = env.state.sessions[String(uid)];
    if (sess?.state === "payment_pending") {
      return sendMessage(
        chatId,
        "⏳ <b>សូមបញ្ចប់ការទិញបច្ចុប្បន្នជាមុនសិន</b>\n\nអ្នកមានការបញ្ជាទិញមួយកំពុងដំណើរការ។ សូមបញ្ចប់ការទូទាត់ ឬចុច <b>🚫 បោះបង់</b> មុននឹងចាប់ផ្តើមការទិញថ្មី។",
      );
    }
    delete env.state.sessions[String(uid)];
    return showAccountSelection(env, chatId);
  }
}

async function handleCallback(env: Env, cb: any) {
  const data: string = cb.data ?? "";
  const uid: number = cb.from.id;
  const chatId: number = cb.message?.chat?.id;
  const msgId: number = cb.message?.message_id;
  const ans = (text?: string, alert = false) =>
    answerCallbackQuery(cb.id, text, alert);
  await notifyAdminNewUser(env, cb.from);

  if (data.startsWith("buy:")) {
    const at = typeFromCbId(env, data.slice(4));
    if (!at) return ans("ប្រភេទនេះមិនមានទៀតហើយ។", true);
    const sess = env.state.sessions[String(uid)];
    if (sess?.state === "payment_pending")
      return ans("សូមបញ្ចប់ការទិញបច្ចុប្បន្នជាមុនសិន", true);
    await ans();
    const pool = env.state.accounts.account_types[at] ?? [];
    const price = env.state.accounts.prices[at] ?? 0;
    if (pool.length <= 0)
      return sendMessage(chatId, `<i>សូមអភ័យទោស គូប៉ុង ${esc(at)} អស់ពីស្តុក 🪤</i>`);
    env.state.sessions[String(uid)] = {
      state: "waiting_for_quantity",
      account_type: at,
      price,
      available_count: pool.length,
      started_at: Date.now(),
    };
    const typeCbId = typeCallbackId(at);
    const qtyBtns = Array.from(
      { length: Math.min(pool.length, 25) },
      (_, i) => Markup.button.callback(String(i + 1), `qty:${typeCbId}:${i + 1}`),
    );
    const rows: any[][] = [];
    for (let i = 0; i < qtyBtns.length; i += 4) rows.push(qtyBtns.slice(i, i + 4));
    rows.push([Markup.button.callback("🚫 បោះបង់", "cancel_buy")]);
    const ok = await editMessageText(chatId, msgId, "<b>សូមជ្រើសរើសចំនួនដែលចង់ទិញ៖</b>", {
      reply_markup: Markup.inlineKeyboard(rows),
    });
    if (!ok) {
      await sendMessage(chatId, "<b>សូមជ្រើសរើសចំនួនដែលចង់ទិញ៖</b>", {
        reply_markup: Markup.inlineKeyboard(rows),
      });
      deleteMessage(chatId, msgId);
    }
    return;
  }

  if (data.startsWith("qty:")) {
    const parts = data.split(":");
    let at: string | null = null;
    let qty = NaN;
    if (parts.length === 3) {
      at = typeFromCbId(env, parts[1]);
      qty = parseInt(parts[2], 10);
    } else if (parts.length === 2) {
      qty = parseInt(parts[1], 10);
    }
    if (!qty || qty < 1) return ans();
    const sess = env.state.sessions[String(uid)];
    if (!sess || sess.state !== "waiting_for_quantity") return ans();
    if (at && sess.account_type !== at)
      return ans("ប្រភេទផ្លាស់ប្ដូរ — ចាប់ផ្ដើមម្ដងទៀត", true);
    if (qty > (sess.available_count ?? 0))
      return ans(`សុំទោស! មានត្រឹមតែ ${sess.available_count} នៅក្នុងស្តុក`, true);
    sess.quantity = qty;
    sess.total_price = Math.round(qty * (sess.price ?? 0) * 100) / 100;
    deleteMessage(chatId, msgId);
    await startPaymentForSession(env, chatId, uid, sess, cb);
    return;
  }

  if (data === "cancel_buy") {
    await ans();
    delete env.state.sessions[String(uid)];
    await showAccountSelection(env, chatId, msgId);
    return;
  }

  if (data === "cancel_purchase") {
    const sess = env.state.sessions[String(uid)];
    const txnId = sess?.transaction_id;
    if (txnId) {
      try {
        const { paid, data: pd } = await checkKhpayStatus(env, txnId, sess?.md5 ?? null);
        if (paid) {
          await ans("✅ បានទទួលការបង់ប្រាក់!");
          await deliverAccounts(env, chatId, uid, sess!, pd);
          return;
        }
      } catch { /* ignore */ }
    }
    await ans();
    if (sess) {
      for (const k of ["photo_message_id", "qr_message_id"] as const) {
        if (sess[k]) deleteMessage(chatId, sess[k] as number);
      }
      delete env.state.sessions[String(uid)];
    }
    await showAccountSelection(env, chatId);
    return;
  }

  if (data === "check_payment") {
    const sess = env.state.sessions[String(uid)];
    const txnId = sess?.transaction_id;
    if (!txnId) return ans("⚠️ រកមិនឃើញការទូទាត់", true);
    await ans("⏳ កំពុងពិនិត្យ…");
    try {
      const { paid, data: pd } = await checkKhpayStatus(env, txnId, sess?.md5 ?? null);
      if (paid) await deliverAccounts(env, chatId, uid, sess!, pd);
      else await answerCallbackQuery(cb.id, "❌ មិនទាន់បង់ប្រាក់ទេ", true);
    } catch (e) {
      await answerCallbackQuery(cb.id, "❌ មានបញ្ហា: " + (e as Error).message, true);
    }
    return;
  }

  if (data.startsWith("dts:") && isAdmin(env, uid)) {
    const typeName = typeFromCbId(env, data.slice(4)) || data.slice(4);
    if (!env.state.accounts.account_types[typeName])
      return ans("ប្រភេទនេះមិនមានទៀតហើយ!", true);
    await ans();
    const count = env.state.accounts.account_types[typeName].length;
    const price = env.state.accounts.prices[typeName] ?? 0;
    await sendMessage(
      chatId,
      `⚠️ <b>តើអ្នកពិតជាចង់លុបប្រភេទ គូប៉ុង នេះមែនទេ?</b>\n\n<blockquote>🔹 ប្រភេទ: ${esc(typeName)}\n🔹 ចំនួន: ${count}\n🔹 តម្លៃ: $${price}</blockquote>`,
      {
        reply_markup: Markup.inlineKeyboard([[
          Markup.button.callback("✅ បញ្ជាក់លុប", `dtc:${typeCallbackId(typeName)}`),
          Markup.button.callback("🚫 បោះបង់", "dtcancel"),
        ]]),
      },
    );
    return;
  }

  if (data.startsWith("dtc:") && isAdmin(env, uid)) {
    const typeName = typeFromCbId(env, data.slice(4)) || data.slice(4);
    if (!env.state.accounts.account_types[typeName])
      return ans("ប្រភេទនេះមិនមានទៀតហើយ!", true);
    await ans();
    const count = (env.state.accounts.account_types[typeName] ?? []).length;
    delete env.state.accounts.account_types[typeName];
    delete env.state.accounts.prices[typeName];
    deleteMessage(chatId, msgId);
    await sendMessage(
      chatId,
      `✅ <b>បានលុប <code>${esc(typeName)}</code> ចំនួន ${count} records!</b>`,
    );
    return;
  }

  if (data === "dtcancel" && isAdmin(env, uid)) {
    await ans();
    deleteMessage(chatId, msgId);
    await sendMessage(chatId, "🚫 <b>បានបោះបង់ការលុប</b>");
    return;
  }

  await ans();
}

async function handleText(env: Env, msg: any) {
  const uid: number = msg.from.id;
  const chatId: number = msg.chat.id;
  const text: string = (msg.text || "").trim();
  await notifyAdminNewUser(env, msg.from);
  if (env.maintenance && !isAdmin(env, uid))
    return sendMessage(chatId, "🔧 <b>Bot កំពុង Update សូមរង់ចាំមួយភ្លែត...</b>");

  if (text === ADMIN_SETTINGS_BTN && isAdmin(env, uid)) {
    const sess = env.state.sessions[String(uid)] ?? {};
    if (String(sess.state || "").startsWith("admin_input:")) {
      delete env.state.sessions[String(uid)];
    }
    return sendAdminSettingsMenu(chatId);
  }

  if (isAdmin(env, uid)) {
    const sess: Session = env.state.sessions[String(uid)] ?? {};
    const state = sess.state ?? "";
    if (text === BTN_BACK_SETTINGS) {
      delete env.state.sessions[String(uid)];
      return sendAdminSettingsMenu(chatId);
    }
    if (state.startsWith("admin_input:")) {
      return handleAdminInput(env, chatId, uid, msg.message_id, state.slice("admin_input:".length), text);
    }
    if (state === "delete_type_select") {
      const labels = sess.labels || {};
      const typeName = labels[text];
      if (typeName && env.state.accounts.account_types[typeName] !== undefined) {
        const count = env.state.accounts.account_types[typeName].length;
        const price = env.state.accounts.prices[typeName] ?? 0;
        env.state.sessions[String(uid)] = { state: "delete_type_confirm", type_name: typeName };
        return sendMessage(
          chatId,
          `⚠️ <b>តើអ្នកពិតជាចង់លុបប្រភេទ គូប៉ុង នេះមែនទេ?</b>\n\n<blockquote>🔹 ប្រភេទ: ${esc(typeName)}\n🔹 ចំនួន: ${count}\n🔹 តម្លៃ: $${price}</blockquote>`,
          Markup.keyboard([[BTN_DELETE_CONFIRM], [BTN_DELETE_CANCEL]]),
        );
      }
      return;
    }
    if (state === "delete_type_confirm") {
      const typeName = sess.type_name;
      delete env.state.sessions[String(uid)];
      if (text === BTN_DELETE_CONFIRM && typeName) {
        const count = (env.state.accounts.account_types[typeName] ?? []).length;
        delete env.state.accounts.account_types[typeName];
        delete env.state.accounts.prices[typeName];
        return sendMessage(
          chatId,
          `✅ <b>បានលុបប្រភេទ <code>${esc(typeName)}</code> ចំនួន ${count} records!</b>`,
          ADMIN_SETTINGS_KB,
        );
      }
      return sendMessage(chatId, "🚫 <b>បានបោះបង់ការលុប</b>", ADMIN_SETTINGS_KB);
    }
    if (state === "broadcast_confirm") {
      const bcastText = sess.broadcast_text || "";
      delete env.state.sessions[String(uid)];
      if (text === BTN_BROADCAST_CONFIRM && bcastText) {
        await sendMessage(chatId, "📢 កំពុង​ផ្សាយ​សារ ... សូមរង់ចាំ", ADMIN_SETTINGS_KB);
        await runBroadcast(env, chatId, bcastText);
      } else {
        await sendMessage(chatId, "🚫 <b>បាន​បោះបង់​ការ​ផ្សាយ</b>", ADMIN_SETTINGS_KB);
      }
      return;
    }
    if (state === "waiting_for_accounts") {
      if (text === BTN_BACK_SETTINGS || text === BTN_CANCEL_INPUT) {
        delete env.state.sessions[String(uid)];
        return sendAdminSettingsMenu(chatId);
      }
      const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
      if (!lines.length)
        return sendMessage(chatId, "<b>អ៊ីមែលមិនត្រឹមត្រូវតាមទម្រង់</b>", ADD_ACCOUNT_KB);
      const seen = new Set<string>();
      const batchDupes: string[] = [];
      const uniqueLines: string[] = [];
      for (const l of lines) {
        const key = l.toLowerCase();
        if (seen.has(key)) batchDupes.push(l);
        else { seen.add(key); uniqueLines.push(l); }
      }
      if (!uniqueLines.length)
        return sendMessage(
          chatId,
          "❌ <b>គូប៉ុងទាំងអស់ដូចគ្នា!</b>\n\nសូមបញ្ចូលគូប៉ុងខុសៗគ្នា។",
          ADD_ACCOUNT_KB,
        );
      const newAccounts: AccountItem[] = uniqueLines.map((l) => {
        if (l.includes("|")) {
          const [ph, pw] = l.split("|").map((s) => s.trim());
          return { phone: ph, password: pw };
        }
        return { code: l };
      });
      const existingTypes = Object.keys(env.state.accounts.account_types);
      env.state.sessions[String(uid)] = { state: "waiting_for_account_type", accounts: newAccounts };
      const typeRows = [...existingTypes.map((t) => [t]), [BTN_BACK_SETTINGS]];
      const dupeWarn = batchDupes.length ? `\n\n⚠️ រំលង ${batchDupes.length} ដដែលៗក្នុង batch` : "";
      return sendMessage(
        chatId,
        `<b>បានបញ្ចូល គូប៉ុង ចំនួន ${newAccounts.length}${dupeWarn}\n\nសូមជ្រើសរើស ឬបញ្ចូលប្រភេទ គូប៉ុង៖</b>`,
        Markup.keyboard(typeRows),
      );
    }
    if (state === "waiting_for_account_type") {
      if (text === BTN_BACK_SETTINGS || text === BTN_CANCEL_INPUT) {
        delete env.state.sessions[String(uid)];
        return sendAdminSettingsMenu(chatId);
      }
      const existingPrice = env.state.accounts.prices[text];
      env.state.sessions[String(uid)] = { ...sess, state: "waiting_for_price", account_type: text };
      if (existingPrice != null)
        return sendMessage(
          chatId,
          `<b>ប្រភេទ <code>${esc(text)}</code> មានស្រាប់ ដែលមានតម្លៃ ${existingPrice}$\n\nតម្លៃត្រូវតែដូចគ្នា (${existingPrice}$) ដើម្បីបន្ថែម គូប៉ុង</b>`,
          ADD_ACCOUNT_KB,
        );
      return sendMessage(
        chatId,
        `<b>សូមដាក់តម្លៃក្នុងប្រភេទ គូប៉ុង ${esc(text)}</b>`,
        ADD_ACCOUNT_KB,
      );
    }
    if (state === "waiting_for_price") {
      if (text === BTN_BACK_SETTINGS || text === BTN_CANCEL_INPUT) {
        delete env.state.sessions[String(uid)];
        return sendAdminSettingsMenu(chatId);
      }
      const price = parseFloat(text.replace("$", "").trim());
      if (isNaN(price) || price < 0)
        return sendMessage(chatId, "តម្លៃមិនត្រឹមត្រូវ។ សូមបញ្ចូលតម្លៃជាលេខ (ឧ: 5.99)");
      const accountType = sess.account_type!;
      const accsToAdd: AccountItem[] = (sess.accounts as AccountItem[]) ?? [];
      const existingPrice = env.state.accounts.prices[accountType];
      if (
        existingPrice != null &&
        Math.round(existingPrice * 10000) !== Math.round(price * 10000)
      ) {
        return sendMessage(
          chatId,
          `❌ <b>មិនអាចបញ្ចូលបាន!</b>\n\nប្រភេទ <code>${esc(accountType)}</code> មានតម្លៃ <b>${existingPrice}$</b> ស្រាប់។\nតម្លៃ <b>${price}$</b> មិនដូចគ្នា។ សូមប្រើ <b>${existingPrice}$</b>`,
          ADD_ACCOUNT_KB,
        );
      }
      const keyOf = (a: any) =>
        ((a.code || a.email || a.phone || "") as string).toLowerCase();
      const poolKeys = Object.values(env.state.accounts.account_types)
        .flat()
        .map(keyOf)
        .filter(Boolean);
      const deliveredKeys = env.state.purchases
        .flatMap((p) => (p.accounts || []).map(keyOf))
        .filter(Boolean);
      const allExisting = new Set<string>([...poolKeys, ...deliveredKeys]);
      const toAdd = accsToAdd.filter((a) => !allExisting.has(keyOf(a)));
      const dupes = accsToAdd.length - toAdd.length;
      if (!env.state.accounts.account_types[accountType])
        env.state.accounts.account_types[accountType] = [];
      env.state.accounts.account_types[accountType].push(...toAdd);
      env.state.accounts.prices[accountType] = Math.round(price * 10000) / 10000;
      delete env.state.sessions[String(uid)];
      await sendMessage(
        chatId,
        `✅ <b>បានបញ្ចូល គូប៉ុង ដោយជោគជ័យ</b>\n\n<blockquote>🔹 ចំនួន: ${toAdd.length}\n🔹 ប្រភេទ: ${esc(accountType)}\n🔹 តម្លៃ: ${price}$</blockquote>` +
          (dupes ? `\n\n⚠️ ដដែល (រំលង): ${dupes}` : ""),
      );
      return sendAdminSettingsMenu(chatId);
    }
    if (ADMIN_BUTTON_LABELS.has(text)) return dispatchAdminButton(env, chatId, uid, text);
  }

  if (text === "💵 ទិញគូប៉ុង") {
    const sess = env.state.sessions[String(uid)];
    if (sess?.state === "payment_pending")
      return sendMessage(
        chatId,
        "⏳ <b>សូមបញ្ចប់ការទិញបច្ចុប្បន្នជាមុនសិន</b>\n\nអ្នកមានការបញ្ជាទិញមួយកំពុងដំណើរការ។ សូមបញ្ចប់ការទូទាត់ ឬចុច <b>🚫 បោះបង់</b> មុននឹងចាប់ផ្ដើមការទិញថ្មី។",
      );
    delete env.state.sessions[String(uid)];
    return showAccountSelection(env, chatId);
  }

  if (env.state.sessions[String(uid)]?.state === "payment_pending")
    return sendMessage(
      chatId,
      "⏳ <b>សូមបញ្ចប់ការទូទាត់ QR ជាមុនសិន</b>\nឬចុច <b>🚫 បោះបង់</b> ដើម្បីបោះបង់",
      CHECK_PAYMENT_INLINE,
    );
  await showAccountSelection(env, chatId);
}

async function dispatchAdminButton(env: Env, chatId: number, uid: number, btn: string) {
  switch (btn) {
    case BTN_ADD_ACCOUNT:
      env.state.sessions[String(uid)] = { state: "waiting_for_accounts" };
      return sendMessage(chatId, "<b>បញ្ចូលគូប៉ុងសម្រាប់លក់</b>", ADD_ACCOUNT_KB);
    case BTN_DELETE_TYPE: {
      const types = Object.keys(env.state.accounts.account_types);
      if (!types.length)
        return sendMessage(chatId, "⚠️ <b>មិនមានប្រភេទ គូប៉ុង ណាមួយទេ!</b>");
      const labelsMap: Record<string, string> = {};
      const rows = types.map((t) => {
        const count = env.state.accounts.account_types[t].length;
        const label = `${shortLabel(t)} – មានក្នុងស្តុក ${count}`;
        labelsMap[label] = t;
        return [label];
      });
      rows.push([BTN_BACK_SETTINGS]);
      env.state.sessions[String(uid)] = { state: "delete_type_select", labels: labelsMap };
      return sendMessage(
        chatId,
        "🗑 <b>ជ្រើសរើសប្រភេទ គូប៉ុង ដែលចង់លុប៖</b>",
        Markup.keyboard(rows),
      );
    }
    case BTN_STOCK: return exportStock(env, chatId);
    case BTN_BUYERS: return exportBuyers(env, chatId);
    case BTN_USERS: return showUsersList(env, chatId);
    case BTN_KHPAY:
      return sendMessage(
        chatId,
        `💰 <b>Cambo API Token បច្ចុប្បន្ន៖</b>\n\n<code>${esc(env.camboToken)}</code>`,
        KHPAY_SUBMENU_KB,
      );
    case BTN_KHPAY_KEY_EDIT:
      env.state.sessions[String(uid)] = { state: "admin_input:khpay_key" };
      return sendMessage(
        chatId,
        "💰 សូមផ្ញើ <b>Cambo API Token</b> ថ្មី:\n\n<i>ចុច 🚫 បោះបង់ ដើម្បីបោះបង់</i>",
        CANCEL_INPUT_KB,
      );
    case BTN_KHPAY_INFO: return sendKhpayInfo(env, chatId);
    case BTN_CHANNEL: {
      const cur = env.channelId || "(មិនទាន់កំណត់)";
      return sendMessage(
        chatId,
        `📢 <b>Channel ID បច្ចុប្បន្ន៖</b>\n<code>${esc(String(cur))}</code>`,
        CHANNEL_SUBMENU_KB,
      );
    }
    case BTN_CHANNEL_EDIT:
      env.state.sessions[String(uid)] = { state: "admin_input:channel" };
      return sendMessage(
        chatId,
        "📢 សូមផ្ញើ <b>Channel ID</b> ថ្មី (ឧ. <code>-1001234567890</code>):\n\n<i>ចុច 🚫 បោះបង់ ដើម្បីបោះបង់</i>",
        CANCEL_INPUT_KB,
      );
    case BTN_CHANNEL_CLEAR:
      env.channelId = "";
      return sendMessage(chatId, "✅ បានលុប Channel ID", ADMIN_SETTINGS_KB);
    case BTN_ADMINS: {
      const extras = [...env.extraAdmins].sort();
      const extrasStr = extras.length
        ? extras.map((x) => `• <code>${x}</code>`).join("\n")
        : "(គ្មាន)";
      return sendMessage(
        chatId,
        `👑 <b>Admin បឋម៖</b> <code>${ADMIN_ID}</code>\n\n➕ <b>Admin បន្ថែម៖</b>\n${extrasStr}`,
        ADMINS_SUBMENU_KB,
      );
    }
    case BTN_ADMIN_ADD:
      env.state.sessions[String(uid)] = { state: "admin_input:admin_add" };
      return sendMessage(
        chatId,
        "➕ សូមផ្ញើ <b>Telegram User ID</b> ដែលចង់បន្ថែម:",
        CANCEL_INPUT_KB,
      );
    case BTN_ADMIN_REMOVE:
      env.state.sessions[String(uid)] = { state: "admin_input:admin_remove" };
      return sendMessage(
        chatId,
        "➖ សូមផ្ញើ <b>Telegram User ID</b> ដែលចង់ដក:",
        CANCEL_INPUT_KB,
      );
    case BTN_MAINTENANCE: {
      const status = env.maintenance ? "🔴 បិទ" : "🟢 បើក";
      return sendMessage(
        chatId,
        `🛠 <b>ស្ថានភាព Bot បច្ចុប្បន្ន៖</b> ${status}`,
        MAINTENANCE_SUBMENU_KB,
      );
    }
    case BTN_MAINT_ON:
      env.maintenance = true;
      return sendMessage(chatId, "🔴 បានបិទ Bot", ADMIN_SETTINGS_KB);
    case BTN_MAINT_OFF:
      env.maintenance = false;
      return sendMessage(chatId, "🟢 បានបើក Bot", ADMIN_SETTINGS_KB);
    case BTN_BROADCAST:
      env.state.sessions[String(uid)] = { state: "admin_input:broadcast" };
      return sendMessage(
        chatId,
        "📢 សូមផ្ញើ​សារ​ដែល​ចង់​ផ្សាយ​ទៅ​អ្នក​ប្រើ​ប្រាស់​ទាំង​អស់៖\n\n<i>ចុច 🚫 បោះបង់ ដើម្បីបោះបង់</i>",
        CANCEL_INPUT_KB,
      );
    default:
      return sendAdminSettingsMenu(chatId);
  }
}

async function handleAdminInput(
  env: Env,
  chatId: number,
  uid: number,
  msgId: number,
  key: string,
  text: string,
) {
  const cancelWords = new Set(["បោះបង់", "🚫 បោះបង់", BTN_CANCEL_INPUT, BTN_BACK_SETTINGS]);
  if (cancelWords.has(text)) {
    delete env.state.sessions[String(uid)];
    return sendAdminSettingsMenu(chatId);
  }
  if (key === "khpay_key") {
    if (!text)
      return sendMessage(
        chatId,
        "❌ Token មិនត្រឹមត្រូវ\n\nសូមផ្ញើ Token ត្រឹមត្រូវ (ឬចុច 🚫 បោះបង់)",
      );
    env.camboToken = text;
    delete env.state.sessions[String(uid)];
    deleteMessage(chatId, msgId);
    return sendMessage(
      chatId,
      `✅ បានប្តូរ <b>Cambo API Token</b>\n<code>${esc(text.slice(0, 12))}…${esc(text.slice(-4))}</code>`,
      mainKb(env, uid),
    );
  }
  if (key === "channel") {
    if (!text) return sendMessage(chatId, "សូមផ្ញើ Channel ID ថ្មី ឬ <code>off</code> ដើម្បីបិទ");
    if (["off", "none", "clear", "delete", "remove"].includes(text.toLowerCase())) {
      env.channelId = "";
    } else {
      env.channelId = text;
    }
    delete env.state.sessions[String(uid)];
    return sendMessage(
      chatId,
      `✅ បានកំណត់ Channel ID ទៅជា <code>${esc(env.channelId || "(ទទេ)")}</code>`,
      mainKb(env, uid),
    );
  }
  if (key === "admin_add") {
    const target = parseInt(text, 10);
    if (isNaN(target))
      return sendMessage(chatId, "❌ user_id ត្រូវតែជាលេខ (ឬចុច 🚫 បោះបង់)");
    if (target === ADMIN_ID) {
      delete env.state.sessions[String(uid)];
      return sendMessage(chatId, "ℹ️ Admin បឋមមិនអាចលុប/បន្ថែមបានទេ។", mainKb(env, uid));
    }
    env.extraAdmins.add(target);
    delete env.state.sessions[String(uid)];
    return sendMessage(chatId, `✅ បានបន្ថែម <code>${target}</code> ជា admin`);
  }
  if (key === "admin_remove") {
    const target = parseInt(text, 10);
    if (isNaN(target))
      return sendMessage(chatId, "❌ user_id ត្រូវតែជាលេខ (ឬចុច 🚫 បោះបង់)");
    env.extraAdmins.delete(target);
    delete env.state.sessions[String(uid)];
    return sendMessage(chatId, `✅ បានដក <code>${target}</code> ចាក admin`);
  }
  if (key === "broadcast") {
    env.state.sessions[String(uid)] = {
      state: "broadcast_confirm",
      broadcast_text: text,
    };
    return sendMessage(
      chatId,
      `📢 <b>ព្រមព្រៀងផ្សាយ:</b>\n\n${esc(text)}\n\n<i>ផ្សាយទៅអ្នកប្រើ ${Object.keys(env.state.users).length} នាក់</i>`,
      BROADCAST_CONFIRM_KB,
    );
  }
}

async function runBroadcast(env: Env, adminChatId: number, bcastText: string) {
  const uids = Object.keys(env.state.users);
  let sent = 0,
    failed = 0,
    blocked = 0;
  for (const uidStr of uids) {
    const uid = Number(uidStr);
    try {
      const res = await sendMessage(uid, bcastText);
      if (res) sent++;
      else failed++;
    } catch (e) {
      const msg = (e as Error).message || "";
      if (/blocked|deactivated|kicked|not found/i.test(msg)) blocked++;
      else failed++;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  await sendMessage(
    adminChatId,
    "📢 <b>ផ្សាយ​សារ​បាន​ចប់</b>\n" +
      "━━━━━━━━━━━━━━━━━━━\n" +
      `👥 សរុប:         ${uids.length}\n` +
      `✅ ផ្ញើ​ជោគជ័យ:   ${sent}\n` +
      `⛔ បាន​ប្លុក/លុប:  ${blocked}\n` +
      `❌ បរាជ័យ:        ${failed}`,
    ADMIN_SETTINGS_KB,
  );
}

async function exportStock(env: Env, chatId: number) {
  const types = env.state.accounts.account_types;
  const prices = env.state.accounts.prices;
  const names = Object.keys(types).sort();
  if (!names.length)
    return sendMessage(chatId, "📦 មិនមានប្រភេទ គូប៉ុង ឡើយទេ។", ADMIN_SETTINGS_KB);
  const totalAvail = names.reduce((s, t) => s + (types[t] || []).length, 0);
  const W = 60;
  const lines = [
    "=".repeat(W),
    "  ស្តុក គូប៉ុង / COUPON STOCK".padEnd(W),
    `  ${nowKH()}`.padEnd(W),
    `  ប្រភេទ: ${names.length}  |  សរុប: ${totalAvail} គូប៉ុង`.padEnd(W),
    "=".repeat(W),
    "",
  ];
  for (const t of names) {
    const pool = types[t] || [];
    const price = prices[t] ?? 0;
    lines.push(`[ ${t} ]  💰 $${price}  📦 ${pool.length} គូប៉ុង`, "─".repeat(W));
    if (pool.length) pool.forEach((acc, i) => lines.push(`  ${i + 1}. ${formatAccount(acc)}`));
    else lines.push("  (គ្មានក្នុងស្តុក)");
    lines.push("");
  }
  lines.push("=".repeat(W));
  const buf = new TextEncoder().encode(lines.join("\n"));
  await sendDocument(
    chatId,
    buf,
    `stock_${nowKHFile()}.txt`,
    `📦 <b>ស្តុក គូប៉ុង</b> — ${names.length} ប្រភេទ, ${totalAvail} នៅសល់`,
  );
  return sendAdminSettingsMenu(chatId);
}

async function exportBuyers(env: Env, chatId: number) {
  if (!env.state.purchases.length)
    return sendMessage(chatId, "មិនមានទិន្នន័យ​ទិញ​នៅឡើយ​ទេ។", ADMIN_SETTINGS_KB);
  const grouped: Record<string, { first_name: string; last_name: string; username: string; purchases: typeof env.state.purchases }> = {};
  for (const p of env.state.purchases) {
    const uid = String(p.user_id);
    if (!grouped[uid]) {
      const u = env.state.users[uid] || ({} as any);
      grouped[uid] = {
        first_name: u.first_name || "",
        last_name: u.last_name || "",
        username: u.username || "",
        purchases: [],
      };
    }
    grouped[uid].purchases.push(p);
  }
  const W = 60;
  const lines: string[] = [
    "=".repeat(W),
    "  BUYERS REPORT".padStart((W + 14) / 2).padEnd(W),
    `  ${nowKH()}`.padEnd(W),
    "=".repeat(W),
    `  Total buyers : ${Object.keys(grouped).length}`,
  ];
  for (const [uid, info] of Object.entries(grouped)) {
    const fn = [info.first_name, info.last_name].filter(Boolean).join(" ") || "(no name)";
    const un = info.username ? `@${info.username}` : "—";
    lines.push("", "─".repeat(W), `  ID       : ${uid}`, `  Name     : ${fn}`, `  Username : ${un}`, `  Purchases: ${info.purchases.length}`, "─".repeat(W));
    info.purchases.forEach((p, i) => {
      const when = fmtKH(p.purchased_at);
      lines.push(
        `  [${i + 1}] ${p.account_type}`,
        `      Qty   : ${p.quantity}`,
        `      Price : $${p.total_price}`,
        `      Date  : ${when}`,
        "      Accounts:",
      );
      (p.accounts || []).forEach((a) => lines.push(`        • ${formatAccount(a)}`));
      if (!(p.accounts || []).length) lines.push("        (none)");
    });
  }
  lines.push("", "=".repeat(W), "=".repeat(W));
  const buf = new TextEncoder().encode(lines.join("\n"));
  await sendDocument(
    chatId,
    buf,
    `buyers_${nowKHFile()}.txt`,
    `📋 របាយការណ៍ទិញ — ${Object.keys(grouped).length} អ្នក​ទិញ`,
  );
  return sendAdminSettingsMenu(chatId);
}

async function showUsersList(env: Env, chatId: number) {
  const rows = Object.entries(env.state.users);
  if (!rows.length)
    return sendMessage(chatId, "📭 <b>មិនទាន់មានអ្នកប្រើប្រាស់ទេ។</b>", BACK_SETTINGS_KB);
  const lines: string[] = [`👥 អ្នកប្រើប្រាស់សរុប: ${rows.length}`, ""];
  for (const [uid, info] of rows) {
    const full = [info.first_name, info.last_name].filter(Boolean).join(" ") || "N/A";
    const uname = info.username ? `@${info.username}` : "—";
    lines.push(`${full}`, `   🔖 ${uname}`, `   🪪 ${uid}`, "");
  }
  const buf = new TextEncoder().encode(lines.join("\n"));
  await sendDocument(
    chatId,
    buf,
    `users_${nowKHFile()}.txt`,
    `👥 បញ្ជីអ្នកប្រើប្រាស់ — ${rows.length} នាក់`,
  );
  return sendAdminSettingsMenu(chatId);
}

async function sendKhpayInfo(env: Env, chatId: number) {
  const token = env.camboToken;
  const short = token
    ? `<code>${esc(token.slice(0, 16))}…${esc(token.slice(-4))}</code>`
    : "❌ មិនទាន់កំណត់";
  const lines = [
    "💰 <b>Cambo Payment Info</b>",
    "━━━━━━━━━━━━━━━━━━━",
    `🌐 <b>API:</b> <code>bakong.cambo-kh.com</code>`,
    `🔑 <b>Token:</b> ${short}`,
    "━━━━━━━━━━━━━━━━━━━",
    `✅ <b>Generate QR:</b> type=generate_qr`,
    `✅ <b>Check MD5:</b> type=check_md5`,
  ];
  return sendMessage(chatId, lines.join("\n"), KHPAY_SUBMENU_KB);
}

async function handleChannelPost(env: Env, post: any) {
  try {
    const text: string = post?.text || post?.caption || "";
    if (!text) return;
    if (!text.includes("noreply@e-gets.com") && !text.includes("e-gets.com")) return;
    const emailMatch = text.match(/📧[^\n:]*:\s*([^\s\n]+)/);
    if (!emailMatch) return;
    const email = emailMatch[1].trim();
    const codeMatch = text.match(/^\s*(\d{4,8})\s*$/m);
    if (!codeMatch) return;
    const code = codeMatch[1].trim();
    const matched = env.state.purchases.filter((p) =>
      (p.accounts || []).some(
        (a: any) =>
          ((a.email || a.code || "") as string).trim().toLowerCase() === email.toLowerCase(),
      ),
    );
    if (!matched.length) return;
    const sent = new Set<number>();
    for (const p of matched) {
      const uid = p.user_id;
      if (sent.has(uid)) continue;
      sent.add(uid);
      const msg = `📩 <b>លេខកូដផ្ទៀងផ្ទាត់ E-GetS</b>\n\n<code>${esc(email)}</code>\n\n<code>${code}</code>`;
      await sendMessage(uid, msg);
    }
  } catch (e) {
    console.warn("[EGets] channel_post error:", (e as Error).message);
  }
}

// ---------- entry points ----------
export async function handleUpdate(update: any) {
  const state = await loadState();
  const env = envFromState(state);
  try {
    if (update.message) {
      const msg = update.message;
      if (msg.text?.startsWith("/")) await handleCommand(env, msg);
      else if (msg.text != null) await handleText(env, msg);
    } else if (update.edited_message?.text != null) {
      // treat edits as text
      await handleText(env, update.edited_message);
    } else if (update.callback_query) {
      await handleCallback(env, update.callback_query);
    } else if (update.channel_post) {
      await handleChannelPost(env, update.channel_post);
    }
  } catch (e) {
    console.warn("[bot] handler error:", (e as Error).message);
  }
  persistEnv(env);
  await saveState(env.state);
}

/**
 * Payment watchdog — invoked by pg_cron.
 * Polls pending sessions, delivers paid ones, expires stale ones.
 */
export async function runWatchdog() {
  const state = await loadState();
  const env = envFromState(state);
  const pending = Object.entries(env.state.sessions).filter(
    ([, s]) => s.state === "payment_pending",
  );
  let checked = 0,
    delivered = 0,
    expired = 0;
  for (const [uidStr, sess] of pending) {
    const userId = Number(uidStr);
    const { transaction_id, qr_sent_at } = sess;
    const elapsed = Date.now() - (qr_sent_at || 0);
    if (elapsed >= PAYMENT_TIMEOUT_SEC * 1000) {
      delete env.state.sessions[uidStr];
      if (sess.photo_message_id) deleteMessage(userId, sess.photo_message_id);
      await showAccountSelection(env, userId);
      expired++;
      continue;
    }
    if (!transaction_id) continue;
    try {
      const { paid, data: pd } = await checkKhpayStatus(env, transaction_id, sess.md5 ?? null);
      checked++;
      if (!paid) continue;
      sess.state = "delivering";
      await deliverAccounts(env, userId, userId, sess, pd);
      delivered++;
    } catch (e) {
      console.warn(`[watchdog] check error for ${transaction_id}:`, (e as Error).message);
    }
  }
  persistEnv(env);
  await saveState(env.state);
  return { pending: pending.length, checked, delivered, expired };
}
