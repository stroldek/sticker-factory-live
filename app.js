const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MAX_STICKERS = 120;        // Telegram limit for static sticker sets
const MAX_BYTES = 500 * 1024;    // Telegram limit is 512 KB; keep a small margin
const PREFS_KEY = "sf2_prefs";
const QUICK_EMOJI = ["😀", "😂", "🔥", "❤️", "👍", "😎", "🥳", "😭"];
import { quantizedPng } from "./imaging.js";
import { t, tp, setLang, getLang, applyStatic } from "./i18n.js";

// ---------- state ----------
let session = { configured: false, bot: "", user: null };
let packs = [];            // packs created in this browser by the logged-in user
let prefs = (() => { try { return { title: "", emoji: "😀", fit: "contain", round: false, ...JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") }; } catch { return { title: "", emoji: "😀", fit: "contain", round: false }; } })();
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode */ } };
const packsKey = () => `sf2_packs_${session.user ? session.user.id : "anon"}`;
const loadPacks = () => { try { packs = JSON.parse(localStorage.getItem(packsKey()) || "[]"); } catch { packs = []; } };
const savePacks = () => { try { localStorage.setItem(packsKey(), JSON.stringify(packs)); } catch { /* ignore */ } };
const connected = () => !!(session.configured && session.user);

// ---------- helpers ----------
let toastTimer;
function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 3600); }
function setHint(id, text, kind = "") { const e = $(id); e.textContent = text; e.className = "hint" + (kind ? " " + kind : ""); }
const pickEmoji = s => { const m = (s || "").match(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*/u); return m ? m[0] : null; };

// Localized text for a raw Telegram error description
function explain(msg) {
  const d = String(msg || "");
  if (d === "tg_unavailable") return t("err.tg_unavailable");
  if (/user not found|PEER_ID_INVALID|chat not found/i.test(d)) return t("err.userNotFound", { bot: session.bot });
  if (/occupied/i.test(d)) return t("err.occupied");
  if (/STICKERSET_INVALID|stickerset_invalid|sticker set.*(not found|invalid)/i.test(d)) return t("err.invalidSet");
  if (/STICKERS_TOO_MUCH|too much|too many stickers/i.test(d)) return t("err.full");
  if (/emoji/i.test(d)) return t("err.emoji");
  if (/not the owner|owner|can't be used|not enough rights|user_id/i.test(d)) return t("err.owner");
  if (/too big|too large/i.test(d)) return t("err.fileBig");
  return d;
}

// ---------- server API ----------
class ApiError extends Error {
  constructor(code, status, { detail = "", retryAfter = 0, quota = false } = {}) { super(code); this.code = code; this.status = status; this.detail = detail; this.retryAfter = retryAfter; this.quota = quota; }
}
async function apiFetch(path, init = {}, tries = 6) {
  for (let i = 0; ; i++) {
    let res;
    try { res = await fetch(path, { ...init, headers: { "X-Requested-With": "sticker-factory", ...(init.headers || {}) }, credentials: "same-origin" }); }
    catch { if (i < 2) { await sleep(1200 * (i + 1)); continue; } throw new ApiError("net", 0); }
    let data = null; try { data = await res.json(); } catch { /* ignore */ }
    if (res.ok) return data;
    if (res.status === 429 && !(data && data.quota) && i < tries) { await sleep(((data && data.retryAfter) || 3) * 1000 + 1000); continue; }
    throw new ApiError((data && data.code) || "http", res.status, { detail: (data && data.error) || String(res.status), retryAfter: data && data.retryAfter, quota: data && data.quota });
  }
}
// Human-readable, localized message for any error
function errText(e) {
  if (!(e instanceof ApiError)) return explain(e && e.message);
  if (e.code === "tg") return explain(e.detail);
  if (e.code === "http") return t("err.http", { status: e.status });
  return t("err." + e.code);
}
const sendSticker = (path, fields, blob, filename) => { const fd = new FormData(); for (const [k, v] of Object.entries(fields)) fd.append(k, v); fd.append("file", blob, filename); return apiFetch(path, { method: "POST", body: fd }); };

// ---------- login ----------
let widgetFailed = false, serverFail = false, loginResult = null; // loginResult: "failed" | "denied" | null
function mountWidget() {
  widgetFailed = false; renderLoginHints();
  const slot = $("loginWidget"); slot.innerHTML = "";
  const sc = document.createElement("script");
  sc.async = true; sc.src = "https://telegram.org/js/telegram-widget.js?22";
  sc.dataset.telegramLogin = session.bot; sc.dataset.size = "large"; sc.dataset.radius = "12"; sc.dataset.authUrl = "/auth/telegram";
  sc.onerror = () => { widgetFailed = true; renderLoginHints(); };
  slot.append(sc);
}

function renderLoginHints() {
  if (!session.configured) {
    $("loginLead").textContent = t("login.unconfigured");
    setHint("loginHint", session.missing ? t("login.missing", { list: session.missing.join(", ") }) : serverFail ? t("login.serverFail") : "", "err");
    return;
  }
  $("loginLead").textContent = t("login.lead");
  const msg = loginResult ? t("login." + loginResult) : widgetFailed ? t("login.widgetFail") : "";
  setHint("loginHint", msg, msg ? "err" : "");
}

function renderConnect() {
  const ok = connected();
  $("loginView").hidden = ok; $("connectedView").hidden = !ok;
  $("connectStatus").textContent = ok ? t("login.on") : t("login.off"); $("connectStatus").classList.toggle("on", ok);
  if (ok) { $("whoUser").textContent = session.user.name || `ID ${session.user.id}`; $("whoBot").textContent = t("who.bot", { bot: session.bot }); }
  $("maintBanner").hidden = !session.maintenance;
  renderLoginHints(); refreshTargets(); renderHistory(); updateCreateState();
}

async function loadSession() {
  try {
    const r = await fetch("/api/session", { credentials: "same-origin" });
    session = await r.json();
  } catch { session = { configured: false, bot: "", user: null }; serverFail = true; }
  loadPacks();
  if (session.configured && !session.user) mountWidget();
  const q = new URLSearchParams(location.search).get("login");
  if (q) { loginResult = q === "denied" ? "denied" : "failed"; history.replaceState(null, "", "/"); }
  renderConnect();
}
$("logoutBtn").onclick = async () => { try { await apiFetch("/api/logout", { method: "POST" }); } catch { /* ignore */ } session.user = null; packs = []; renderConnect(); mountWidget(); };

// ---------- options ----------
function renderPrefs() {
  $("packTitle").value = prefs.title; $("defaultEmoji").value = prefs.emoji; $("roundCorners").checked = prefs.round;
  document.querySelectorAll("#fitSeg button").forEach(b => b.classList.toggle("on", b.dataset.v === prefs.fit));
  const chips = $("emojiChips"); chips.innerHTML = "";
  for (const em of QUICK_EMOJI) { const b = document.createElement("button"); b.type = "button"; b.textContent = em; b.classList.toggle("on", em === prefs.emoji); b.onclick = () => { prefs.emoji = em; $("defaultEmoji").value = em; savePrefs(); renderPrefs(); render(); }; chips.append(b); }
}
$("defaultEmoji").addEventListener("input", e => { const em = pickEmoji(e.target.value); if (em) { prefs.emoji = em; savePrefs(); render(); } });
$("defaultEmoji").addEventListener("blur", () => { $("defaultEmoji").value = prefs.emoji; renderPrefs(); });
$("packTitle").addEventListener("input", e => { prefs.title = e.target.value; savePrefs(); });
$("roundCorners").addEventListener("change", e => { prefs.round = e.target.checked; savePrefs(); });
$("fitSeg").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; prefs.fit = b.dataset.v; savePrefs(); renderPrefs(); });
$("packTarget").addEventListener("change", () => { $("packTitle").disabled = !!$("packTarget").value; updateCreateState(); });
function refreshTargets() {
  const sel = $("packTarget"), cur = sel.value; sel.length = 1; sel.options[0].textContent = t("opt.targetNew");
  for (const p of packs) { const o = document.createElement("option"); o.value = p.name; o.textContent = t("opt.targetAdd", { title: p.title }); sel.append(o); }
  sel.value = [...sel.options].some(o => o.value === cur) ? cur : ""; $("packTitle").disabled = !!sel.value;
}

// ---------- queue ----------
let items = []; let nextId = 1; let busy = false;

function dims(src) { return [src.naturalWidth || src.width, src.naturalHeight || src.height]; }
async function decode(file) {
  try { return await createImageBitmap(file); }
  catch {
    const url = URL.createObjectURL(file);
    try { const img = new Image(); img.src = url; await img.decode(); return img; }
    finally { URL.revokeObjectURL(url); }
  }
}
async function makeThumb(file) {
  const src = await decode(file); const [w, h] = dims(src); const s = Math.min(1, 200 / Math.max(w, h));
  const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height); src.close?.();
  return await new Promise(r => c.toBlob(b => r(URL.createObjectURL(b)), "image/png"));
}

async function addFiles(files) {
  const list = [...files].filter(f => f.type.startsWith("image/") || /\.(heic|heif|jpe?g|png|webp|gif|bmp|avif)$/i.test(f.name));
  if (!list.length) return toast(t("add.noImages"));
  const room = MAX_STICKERS - items.length;
  if (list.length > room) toast(t("add.limit", { max: MAX_STICKERS, n: Math.max(room, 0) }));
  let failed = 0, done = 0;
  for (const file of list.slice(0, Math.max(room, 0))) {
    $("queueMeta").textContent = t("photos.preparing", { i: ++done, n: Math.min(list.length, room) });
    try { items.push({ id: nextId++, file, url: await makeThumb(file), emoji: null }); }
    catch { failed++; }
  }
  if (failed) toast(t("add.openFail", { n: failed }));
  render();
}

function render() {
  const grid = $("grid"); grid.innerHTML = "";
  items.forEach((item, i) => {
    const card = document.createElement("div"); card.className = "thumb item";
    const box = document.createElement("div"); box.className = "box";
    const img = document.createElement("img"); img.src = item.url; img.alt = item.file.name;
    const num = document.createElement("span"); num.className = "num"; num.textContent = i + 1;
    const del = document.createElement("button"); del.className = "remove"; del.textContent = "×"; del.setAttribute("aria-label", t("remove"));
    del.onclick = () => { if (busy) return; URL.revokeObjectURL(item.url); items = items.filter(x => x !== item); render(); };
    box.append(img, num, del);
    const emo = document.createElement("button"); emo.className = "emo" + (item.emoji ? " custom" : ""); emo.textContent = item.emoji || prefs.emoji;
    emo.setAttribute("aria-label", t("emoji.change"));
    emo.onclick = () => {
      if (busy) return;
      const v = prompt(t("emoji.prompt"), item.emoji || "");
      if (v === null) return;
      item.emoji = v.trim() ? pickEmoji(v) : null;
      if (v.trim() && !item.emoji) toast(t("emoji.none"));
      render();
    };
    card.append(box, emo); grid.append(card);
  });
  $("dropTitle").textContent = items.length ? t("drop.more") : t("drop.choose");
  $("clearBtn").disabled = !items.length; $("gridTip").hidden = !items.length;
  $("queueMeta").textContent = items.length ? t("photos.count", { n: items.length, max: MAX_STICKERS }) : t("photos.none");
  updateCreateState();
}

$("fileInput").addEventListener("change", async e => { await addFiles(e.target.files); e.target.value = ""; });
$("clearBtn").onclick = () => { if (busy) return; items.forEach(x => URL.revokeObjectURL(x.url)); items = []; render(); };
const dz = $("dropzone");
["dragenter", "dragover"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add("drag"); }));
["dragleave", "drop"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove("drag"); }));
dz.addEventListener("drop", e => addFiles(e.dataTransfer.files));
window.addEventListener("dragover", e => e.preventDefault()); window.addEventListener("drop", e => e.preventDefault());

function updateCreateState() {
  const ok = connected() && items.length > 0 && !busy;
  $("createBtn").disabled = !ok;
  $("createBtn").textContent = items.length ? t("create.n", { n: items.length }) : t("create");
  $("createHint").textContent = !connected() ? t("hint.login") : !items.length ? t("hint.choose") : $("packTarget").value ? t("hint.add") : t("hint.new");
}

// ---------- image → Telegram sticker ----------
const toBlob = (c, type, q) => new Promise(r => c.toBlob(r, type, q));

function roundedClip(ctx, w, h) {
  const r = Math.min(w, h) * 0.09;
  ctx.beginPath(); ctx.moveTo(r, 0); ctx.arcTo(w, 0, w, h, r); ctx.arcTo(w, h, 0, h, r); ctx.arcTo(0, h, 0, 0, r); ctx.arcTo(0, 0, w, 0, r); ctx.closePath(); ctx.clip();
}

async function encode(canvas) {
  // 1) WebP where the browser can encode it (Chrome, Firefox, Android)
  let b = await toBlob(canvas, "image/webp", 0.92);
  if (b && b.type === "image/webp") {
    if (b.size <= MAX_BYTES) return { blob: b, ext: "webp" };
    for (const q of [0.8, 0.65, 0.5]) { b = await toBlob(canvas, "image/webp", q); if (b.size <= MAX_BYTES) return { blob: b, ext: "webp" }; }
  } else {
    // 2) iOS Safari can't encode WebP and silently returns PNG: use PNG if it fits
    const p = await toBlob(canvas, "image/png");
    if (p && p.size <= MAX_BYTES) return { blob: p, ext: "png" };
  }
  // 3) Palette-quantized PNG (256 colours, dithered) — always small enough
  if (typeof CompressionStream === "undefined") throw new Error(t("enc.old"));
  const d = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
  const bytes = await quantizedPng(d.data, canvas.width, canvas.height);
  const blob = new Blob([bytes], { type: "image/png" });
  if (blob.size > 512 * 1024) throw new Error(t("enc.big"));
  return { blob, ext: "png" };
}

async function processFile(file, { fit, round }) {
  const src = await decode(file); const [sw, sh] = dims(src);
  let w, h;
  if (fit === "cover") { w = h = 512; }
  else { const s = 512 / Math.max(sw, sh); w = Math.max(1, Math.round(sw * s)); h = Math.max(1, Math.round(sh * s)); }
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const ctx = c.getContext("2d", { alpha: true, willReadFrequently: false });
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  if (round) roundedClip(ctx, w, h);
  if (fit === "cover") { const s = Math.min(sw, sh); ctx.drawImage(src, (sw - s) / 2, (sh - s) / 2, s, s, 0, 0, 512, 512); }
  else ctx.drawImage(src, 0, 0, w, h);
  src.close?.();
  const out = await encode(c);
  c.width = c.height = 0; // free memory early (matters on iOS)
  return out;
}

// ---------- create pack ----------
let stopRequested = false;
const fatal = e => e && (e.status === 401 || e.status === 503 || e.status === 0 || e.quota);
function addLog(text, bad) { const li = document.createElement("li"); li.textContent = text; if (bad) li.className = "bad"; $("log").prepend(li); }

async function createPack() {
  if (busy || !connected() || !items.length) return;
  busy = true; stopRequested = false; updateCreateState();
  const emojiDefault = pickEmoji(prefs.emoji) || "😀";
  const opts = { fit: prefs.fit, round: prefs.round };
  let name = $("packTarget").value; const isNew = !name;
  let title = (prefs.title || "").trim() || t("opt.nameDefault");
  let queue = items.slice();
  $("progressPanel").hidden = false; $("resultPanel").hidden = true; $("log").innerHTML = "";
  $("stopBtn").disabled = false; $("barFill").style.width = "0%"; $("progressTitle").textContent = t("prog.creating"); $("progressMeta").textContent = "";
  $("progressPanel").scrollIntoView({ behavior: "smooth", block: "start" });
  let wake = null; try { wake = await navigator.wakeLock?.request("screen"); } catch { /* ignore */ }
  const guard = e => { e.preventDefault(); e.returnValue = ""; };
  window.addEventListener("beforeunload", guard);

  let created = !isNew, ok = 0, failed = 0, fatalError = null, link = "", before = 0;
  try {
    if (!isNew) {
      const info = await apiFetch(`/api/pack/info?name=${encodeURIComponent(name)}`);
      title = info.title; before = info.count;
      const room = MAX_STICKERS - info.count;
      if (room <= 0) throw new ApiError("full", 400);
      if (queue.length > room) { queue = queue.slice(0, room); toast(t("prog.room", { n: room })); }
    }
    for (let i = 0; i < queue.length; i++) {
      if (stopRequested) break;
      const item = queue[i];
      $("progressMeta").textContent = t("prog.step", { i: i + 1, n: queue.length });
      try {
        const { blob, ext } = await processFile(item.file, opts);
        const emoji = pickEmoji(item.emoji) || emojiDefault, filename = `sticker_${i + 1}.${ext}`;
        if (!created) { const r = await sendSticker("/api/pack/create", { title, emoji }, blob, filename); name = r.name; link = r.link; created = true; }
        else await sendSticker("/api/pack/add", { name, emoji }, blob, filename);
        ok++; addLog(`✓ ${i + 1}. ${item.file.name}`);
      } catch (e) {
        failed++; addLog(`✗ ${i + 1}. ${item.file.name}: ${errText(e)}`, true);
        if (fatal(e)) { fatalError = e; break; }
      }
      $("barFill").style.width = Math.round(((i + 1) / queue.length) * 100) + "%";
      await sleep(250);
    }
  } catch (e) { fatalError = e; addLog("✗ " + errText(e), true); }
  finally { window.removeEventListener("beforeunload", guard); try { await wake?.release(); } catch { /* ignore */ } }

  busy = false; $("stopBtn").disabled = true;
  if (fatalError && fatalError.status === 401) { session.user = null; renderConnect(); mountWidget(); toast(t("login.expired")); }
  if (created && ok > 0) {
    if (!link) link = `https://t.me/addstickers/${name}`;
    let total = null; try { total = (await apiFetch(`/api/pack/info?name=${encodeURIComponent(name)}`)).count; } catch { /* ignore */ }
    const rec = packs.find(p => p.name === name);
    if (rec) rec.count = total ?? ((rec.count || 0) + ok); else packs.unshift({ name, title, count: total ?? ok, date: Date.now() });
    savePacks(); refreshTargets(); renderHistory();
    $("progressTitle").textContent = stopRequested ? t("prog.stopped") : t("prog.done");
    $("resultTitle").textContent = isNew ? t("res.created") : t("res.added");
    let meta = t("res.uploaded", { ok }) + (failed ? t("res.failed", { failed }) : "");
    if (total !== null) meta += t("res.total", { n: total, word: tp("word.sticker", total) });
    if (!isNew && total !== null && total < before + ok) meta += t("res.lag");
    $("resultMeta").textContent = meta;
    $("resultLink").href = link; $("resultPanel").hidden = false; $("resultPanel").dataset.link = link;
    $("resultPanel").scrollIntoView({ behavior: "smooth", block: "start" });
    items.forEach(x => URL.revokeObjectURL(x.url)); items = []; render();
  } else {
    $("progressTitle").textContent = t("prog.fail");
    $("progressMeta").textContent = fatalError ? errText(fatalError) : stopRequested ? t("prog.stoppedBefore") : t("prog.failNone");
  }
  updateCreateState();
}
$("createBtn").onclick = createPack;
$("stopBtn").onclick = () => { stopRequested = true; $("stopBtn").disabled = true; $("progressMeta").textContent = t("prog.stopping"); };
$("copyLinkBtn").onclick = async () => { const link = $("resultPanel").dataset.link; if (!link) return; try { await navigator.clipboard.writeText(link); toast(t("res.copied")); } catch { prompt(t("res.copyPrompt"), link); } };

// ---------- history ----------
function renderHistory() {
  $("historyPanel").hidden = !packs.length;
  const ul = $("packList"); ul.innerHTML = "";
  for (const p of packs) {
    const li = document.createElement("li");
    const pk = document.createElement("div"); pk.className = "pk";
    const b = document.createElement("b"); b.textContent = p.title;
    const s = document.createElement("small"); s.textContent = `${p.count || "?"} · ${new Date(p.date).toLocaleDateString("ru-RU")}`;
    pk.append(b, s);
    const a = document.createElement("a"); a.href = `https://t.me/addstickers/${p.name}`; a.target = "_blank"; a.rel = "noopener"; a.textContent = t("hist.open");
    li.append(pk, a); ul.append(li);
  }
}

// ---------- settings ----------
function applyAll() {
  applyStatic(); renderPrefs(); renderConnect(); render(); renderHistory(); refreshTargets(); updateCreateState();
  document.querySelectorAll("#langSeg button").forEach(b => b.classList.toggle("on", b.dataset.v === getLang()));
}
$("langSeg").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; setLang(b.dataset.v); applyAll(); });
$("settingsBtn").onclick = () => { $("settingsModal").hidden = false; };
$("closeModal").onclick = () => { $("settingsModal").hidden = true; };
$("settingsModal").addEventListener("click", e => { if (e.target === $("settingsModal")) $("settingsModal").hidden = true; });
$("resetAll").onclick = () => { if (confirm(t("set.resetConfirm"))) { Object.keys(localStorage).filter(k => k.startsWith("sf2_")).forEach(k => localStorage.removeItem(k)); location.reload(); } };

// ---------- init ----------
applyAll();
loadSession();
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("./sw.js").catch(() => {});
