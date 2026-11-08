// Sticker Factory v2 — Cloudflare Pages "advanced mode" worker (single file, no build step).
// Serves the static site and handles /api/* + /auth/telegram.
// Secrets (Pages -> Settings -> Variables and secrets): BOT_TOKEN, BOT_USERNAME, SESSION_SECRET
// Optional: ALLOWED_USER_IDS (comma-separated), DAILY_STICKERS, DAILY_PACKS, MAINTENANCE=1,
//           KV binding named LIMITS (enables per-user daily quotas).

const enc = new TextEncoder();
const dec = new TextDecoder();
const MAX_FILE = 512 * 1024;
const SESSION_SECONDS = 30 * 24 * 3600;
const COOKIE = "sf_session";
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- small crypto helpers ----------
const b64url = bytes => { let s = ""; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const unb64url = str => { let s = str.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; const bin = atob(s); return Uint8Array.from(bin, c => c.charCodeAt(0)); };
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
async function hmac(keyBytes, data) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, typeof data === "string" ? enc.encode(data) : data);
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------- sessions (stateless signed cookie) ----------
async function makeSession(env, user) {
  const payload = b64url(enc.encode(JSON.stringify({ id: user.id, name: user.name, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS })));
  const sig = b64url(await hmac(enc.encode(env.SESSION_SECRET), payload));
  return `${payload}.${sig}`;
}
async function readSession(request, env) {
  const m = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const [payload, sig] = m[1].split(".");
  if (!payload || !sig) return null;
  const good = b64url(await hmac(enc.encode(env.SESSION_SECRET), payload));
  if (!safeEqual(good, sig)) return null;
  try {
    const s = JSON.parse(dec.decode(unb64url(payload)));
    if (!s.id || s.exp < Date.now() / 1000) return null;
    if (!allowed(env, s.id)) return null;
    return { id: s.id, name: s.name || "" };
  } catch { return null; }
}
const cookieHeader = (value, maxAge) => `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
function allowed(env, id) {
  const list = (env.ALLOWED_USER_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
  return list.length === 0 || list.includes(String(id));
}

// ---------- Telegram Login Widget verification ----------
async function verifyLogin(params, botToken) {
  const hash = params.get("hash");
  if (!hash) return null;
  const pairs = [];
  for (const [k, v] of params) if (k !== "hash") pairs.push([k, v]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const check = pairs.map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(botToken)));
  const sig = hex(await hmac(secret, check));
  if (!safeEqual(sig, hash.toLowerCase())) return null;
  const age = Date.now() / 1000 - Number(params.get("auth_date"));
  if (!(age < 86400 && age > -300)) return null;
  const id = Number(params.get("id"));
  if (!id) return null;
  const name = [params.get("first_name"), params.get("last_name")].filter(Boolean).join(" ") || (params.get("username") ? "@" + params.get("username") : "");
  return { id, name };
}

// ---------- Telegram Bot API ----------
class TgError extends Error { constructor(msg, code, retryAfter) { super(msg); this.code = code; this.retryAfter = retryAfter || 0; } }
async function tg(env, method, build, tries = 3) {
  for (let i = 0; ; i++) {
    let res;
    try { res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, { method: "POST", body: build() }); }
    catch { throw new TgError("Telegram недоступен, попробуй ещё раз", 502); }
    let data = null; try { data = await res.json(); } catch { /* ignore */ }
    if (data && data.ok) return data.result;
    const ra = data && data.parameters && data.parameters.retry_after;
    if (ra && ra <= 8 && i < tries) { await sleep((ra + 0.5) * 1000); continue; }
    throw new TgError((data && data.description) || `HTTP ${res.status}`, (data && data.error_code) || res.status, ra);
  }
}
const params = obj => () => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(obj)) p.set(k, v); return p; };

// ---------- helpers ----------
const TRANSLIT = { а: "a", б: "b", в: "v", г: "h", ґ: "g", д: "d", е: "e", є: "ye", ж: "zh", з: "z", и: "y", і: "i", ї: "yi", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya", ё: "yo" };
function slugify(title) {
  let s = ""; for (const ch of title.toLowerCase()) s += TRANSLIT[ch] !== undefined ? TRANSLIT[ch] : ch;
  s = s.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!s) s = "pack"; if (!/^[a-z]/.test(s)) s = "p_" + s;
  return s.slice(0, 30).replace(/_+$/g, "");
}
const makeName = (title, bot) => `${slugify(title)}_${Math.random().toString(36).slice(2, 7)}_by_${bot}`.replace(/_+/g, "_");
const pickEmoji = s => { const m = (s || "").match(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*/u); return m ? m[0] : null; };
const nameOk = (name, bot) => typeof name === "string" && name.length <= 64 && new RegExp(`^[a-z][a-z0-9_]*_by_${bot.replace(/[^\w]/g, "")}$`, "i").test(name);
const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra } });
const fail = (status, error, extra = {}) => json({ error, ...extra }, status);

async function readSticker(form) {
  const file = form.get("file");
  if (!file || typeof file === "string") throw fail(400, "Файл не передан");
  if (file.size === 0 || file.size > MAX_FILE) throw fail(400, "Файл больше 512 КБ");
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const png = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  const webp = head[0] === 0x52 && head[1] === 0x49 && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50;
  if (!png && !webp) throw fail(400, "Нужен WEBP или PNG");
  return { file, ext: png ? "png" : "webp" };
}

// optional per-user daily quotas (needs a KV namespace bound as LIMITS)
async function quota(env, uid, kind, limit) {
  if (!env.LIMITS) return;
  const key = `q:${uid}:${new Date().toISOString().slice(0, 10)}:${kind}`;
  const used = Number(await env.LIMITS.get(key)) || 0;
  if (used >= limit) throw fail(429, kind === "p" ? "Дневной лимит паков исчерпан. Попробуй завтра." : "Дневной лимит стикеров исчерпан. Попробуй завтра.", { retryAfter: 0, quota: true });
  await env.LIMITS.put(key, String(used + 1), { expirationTtl: 2 * 86400 });
}

// ---------- API ----------
async function api(request, env, url) {
  const path = url.pathname;
  const missing = ["BOT_TOKEN", "BOT_USERNAME", "SESSION_SECRET"].filter(k => !env[k]);
  if (path === "/api/session" && request.method === "GET") {
    if (missing.length) return json({ configured: false, missing });
    const user = await readSession(request, env);
    return json({ configured: true, bot: env.BOT_USERNAME, user, maintenance: env.MAINTENANCE === "1" });
  }
  if (missing.length) return fail(503, "Сервер не настроен: нет " + missing.join(", "));
  if (env.MAINTENANCE === "1") return fail(503, "Сервис на техническом обслуживании");

  if (path === "/api/logout" && request.method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": cookieHeader("", 0) });
  }

  // Everything below needs a logged-in user. Custom header = CSRF protection (cross-site forms can't set it).
  if (request.headers.get("X-Requested-With") !== "sticker-factory") return fail(400, "Bad request");
  const user = await readSession(request, env);
  if (!user) return fail(401, "Нужно войти через Telegram");
  const bot = env.BOT_USERNAME;

  try {
    if (path === "/api/pack/info" && request.method === "GET") {
      const name = url.searchParams.get("name");
      if (!nameOk(name, bot)) return fail(400, "Неверное имя пака");
      const set = await tg(env, "getStickerSet", params({ name }));
      return json({ title: set.title, count: set.stickers.length });
    }

    if (path === "/api/pack/create" && request.method === "POST") {
      const form = await request.formData();
      const title = String(form.get("title") || "").trim().slice(0, 64) || "Мой стикерпак";
      const emoji = pickEmoji(String(form.get("emoji") || "")) || "😀";
      const { file, ext } = await readSticker(form);
      await quota(env, user.id, "p", Number(env.DAILY_PACKS) || 10);
      await quota(env, user.id, "s", Number(env.DAILY_STICKERS) || 300);
      let name = makeName(title, bot);
      for (let attempt = 0; ; attempt++) {
        try {
          await tg(env, "createNewStickerSet", () => {
            const fd = new FormData();
            fd.append("user_id", String(user.id)); fd.append("name", name); fd.append("title", title); fd.append("sticker_type", "regular");
            fd.append("stickers", JSON.stringify([{ sticker: "attach://file0", format: "static", emoji_list: [emoji] }]));
            fd.append("file0", file, `sticker.${ext}`);
            return fd;
          });
          break;
        } catch (e) {
          if (/occupied/i.test(e.message) && attempt < 3) { name = makeName(title, bot); continue; }
          throw e;
        }
      }
      return json({ name, title, link: `https://t.me/addstickers/${name}` });
    }

    if (path === "/api/pack/add" && request.method === "POST") {
      const form = await request.formData();
      const name = String(form.get("name") || "");
      if (!nameOk(name, bot)) return fail(400, "Неверное имя пака");
      const emoji = pickEmoji(String(form.get("emoji") || "")) || "😀";
      const { file, ext } = await readSticker(form);
      await quota(env, user.id, "s", Number(env.DAILY_STICKERS) || 300);
      await tg(env, "addStickerToSet", () => {
        const fd = new FormData();
        fd.append("user_id", String(user.id)); fd.append("name", name);
        fd.append("sticker", JSON.stringify({ sticker: "attach://file0", format: "static", emoji_list: [emoji] }));
        fd.append("file0", file, `sticker.${ext}`);
        return fd;
      });
      return json({ ok: true });
    }
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof TgError) return fail(e.code === 429 ? 429 : e.code >= 400 && e.code < 500 ? 400 : 502, e.message, { retryAfter: e.retryAfter || 0 });
    return fail(500, "Внутренняя ошибка");
  }
  return fail(404, "Not found");
}

// ---------- entry ----------
const CSP = "default-src 'self'; script-src 'self' https://telegram.org; frame-src https://oauth.telegram.org https://telegram.org; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/auth/telegram" && request.method === "GET") {
      if (!env.BOT_TOKEN || !env.SESSION_SECRET) return new Response("Server is not configured", { status: 503 });
      const user = await verifyLogin(url.searchParams, env.BOT_TOKEN);
      if (!user) return Response.redirect(new URL("/?login=failed", url).toString(), 302);
      if (!allowed(env, user.id)) return Response.redirect(new URL("/?login=denied", url).toString(), 302);
      return new Response(null, { status: 302, headers: { Location: "/", "Set-Cookie": cookieHeader(await makeSession(env, user), SESSION_SECONDS), "Cache-Control": "no-store" } });
    }

    if (url.pathname.startsWith("/api/")) return api(request, env, url);

    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    out.headers.set("Content-Security-Policy", CSP);
    out.headers.set("X-Content-Type-Options", "nosniff");
    out.headers.set("Referrer-Policy", "no-referrer");
    out.headers.set("X-Frame-Options", "DENY");
    return out;
  },
};
