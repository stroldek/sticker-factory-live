const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MAX_STICKERS = 120;        // Telegram limit for static sticker sets
const MAX_BYTES = 500 * 1024;    // Telegram limit is 512 KB; keep a small margin
const PREFS_KEY = "sf2_prefs";
const QUICK_EMOJI = ["😀", "😂", "🔥", "❤️", "👍", "😎", "🥳", "😭"];
import { quantizedPng } from "./imaging.js";

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
const plural = (n, a, b, c) => { const m = n % 100, d = n % 10; return m > 10 && m < 20 ? c : d === 1 ? a : d > 1 && d < 5 ? b : c; };
const pickEmoji = s => { const m = (s || "").match(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*/u); return m ? m[0] : null; };

function explain(msg) {
  const d = String(msg || "");
  if (/user not found|PEER_ID_INVALID|chat not found/i.test(d)) return `Telegram не нашёл твой аккаунт. Открой бота @${session.bot} и нажми Start, потом повтори.`;
  if (/occupied/i.test(d)) return "Такое имя пака уже занято, попробуй другое название.";
  if (/STICKERSET_INVALID|stickerset_invalid|sticker set.*(not found|invalid)/i.test(d)) return "Такого пака нет или он создан не этим ботом.";
  if (/STICKERS_TOO_MUCH|too much|too many stickers/i.test(d)) return "В паке уже максимум стикеров (120).";
  if (/emoji/i.test(d)) return "Telegram не принял эмодзи для стикера.";
  if (/not the owner|owner|can't be used|not enough rights|user_id/i.test(d)) return "Этот пак создан под другим аккаунтом, добавить в него нельзя.";
  if (/too big|too large|больше 512/i.test(d)) return "Файл слишком большой для Telegram.";
  return d;
}

// ---------- server API ----------
class ApiError extends Error { constructor(msg, status, retryAfter, quota) { super(msg); this.status = status; this.retryAfter = retryAfter || 0; this.quota = !!quota; } }
async function apiFetch(path, init = {}, tries = 6) {
  for (let i = 0; ; i++) {
    let res;
    try { res = await fetch(path, { ...init, headers: { "X-Requested-With": "sticker-factory", ...(init.headers || {}) }, credentials: "same-origin" }); }
    catch { if (i < 2) { await sleep(1200 * (i + 1)); continue; } throw new ApiError("Нет связи с сервером. Проверь интернет.", 0); }
    let data = null; try { data = await res.json(); } catch { /* ignore */ }
    if (res.ok) return data;
    const msg = (data && data.error) || `Ошибка ${res.status}`;
    if (res.status === 429 && !(data && data.quota) && i < tries) { await sleep(((data && data.retryAfter) || 3) * 1000 + 1000); continue; }
    throw new ApiError(msg, res.status, data && data.retryAfter, data && data.quota);
  }
}
const sendSticker = (path, fields, blob, filename) => { const fd = new FormData(); for (const [k, v] of Object.entries(fields)) fd.append(k, v); fd.append("file", blob, filename); return apiFetch(path, { method: "POST", body: fd }); };

// ---------- login ----------
function mountWidget() {
  const slot = $("loginWidget"); slot.innerHTML = "";
  const s = document.createElement("script");
  s.async = true; s.src = "https://telegram.org/js/telegram-widget.js?22";
  s.dataset.telegramLogin = session.bot; s.dataset.size = "large"; s.dataset.radius = "12"; s.dataset.authUrl = "/auth/telegram";
  s.onerror = () => setHint("loginHint", "Не удалось загрузить кнопку Telegram. Проверь интернет или отключи блокировщик рекламы.", "err");
  slot.append(s);
}

function renderConnect() {
  const ok = connected();
  $("loginView").hidden = ok; $("connectedView").hidden = !ok;
  $("connectStatus").textContent = ok ? "ВОШЁЛ" : "НЕ ВОШЁЛ"; $("connectStatus").classList.toggle("on", ok);
  $("connectMeta").textContent = ok ? "Паки создаются на твой аккаунт" : "Паки создаются на твой аккаунт";
  if (ok) { $("whoUser").textContent = session.user.name || `ID ${session.user.id}`; $("whoBot").textContent = `Стикерпаки создаст @${session.bot}`; }
  refreshTargets(); renderHistory(); updateCreateState();
}

async function loadSession() {
  try {
    const r = await fetch("/api/session", { credentials: "same-origin" });
    session = await r.json();
  } catch { session = { configured: false, bot: "", user: null }; setHint("loginHint", "Не удалось связаться с сервером.", "err"); }
  loadPacks();
  if (!session.configured) {
    $("loginLead").textContent = "Сервер ещё не настроен владельцем сайта.";
    setHint("loginHint", session.missing ? "Не хватает настроек: " + session.missing.join(", ") : "", "err");
  } else if (!session.user) mountWidget();
  if (session.maintenance) { const m = document.createElement("div"); m.className = "maint"; m.textContent = "Сервис на техническом обслуживании. Попробуй позже."; $("connectPanel").before(m); }
  const q = new URLSearchParams(location.search).get("login");
  if (q) { setHint("loginHint", q === "denied" ? "Этому аккаунту доступ закрыт." : "Не получилось войти. Попробуй ещё раз.", "err"); history.replaceState(null, "", "/"); }
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
  const sel = $("packTarget"), cur = sel.value; sel.length = 1;
  for (const p of packs) { const o = document.createElement("option"); o.value = p.name; o.textContent = "Добавить в: " + p.title; sel.append(o); }
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
  if (!list.length) return toast("Не нашёл изображений в выбранных файлах");
  const room = MAX_STICKERS - items.length;
  if (list.length > room) toast(`В паке максимум ${MAX_STICKERS} стикеров — добавил ${Math.max(room, 0)}`);
  let failed = 0, done = 0;
  for (const file of list.slice(0, Math.max(room, 0))) {
    $("queueMeta").textContent = `Готовлю превью… ${++done}/${Math.min(list.length, room)}`;
    try { items.push({ id: nextId++, file, url: await makeThumb(file), emoji: null }); }
    catch { failed++; }
  }
  if (failed) toast(`${failed} ${plural(failed, "файл", "файла", "файлов")} не удалось открыть (формат не поддерживается браузером)`);
  render();
}

function render() {
  const grid = $("grid"); grid.innerHTML = "";
  items.forEach((item, i) => {
    const card = document.createElement("div"); card.className = "thumb item";
    const box = document.createElement("div"); box.className = "box";
    const img = document.createElement("img"); img.src = item.url; img.alt = item.file.name;
    const num = document.createElement("span"); num.className = "num"; num.textContent = i + 1;
    const del = document.createElement("button"); del.className = "remove"; del.textContent = "×"; del.setAttribute("aria-label", "Убрать");
    del.onclick = () => { if (busy) return; URL.revokeObjectURL(item.url); items = items.filter(x => x !== item); render(); };
    box.append(img, num, del);
    const emo = document.createElement("button"); emo.className = "emo" + (item.emoji ? " custom" : ""); emo.textContent = item.emoji || prefs.emoji;
    emo.setAttribute("aria-label", "Сменить эмодзи");
    emo.onclick = () => {
      if (busy) return;
      const v = prompt("Эмодзи для этого стикера (пусто — по умолчанию):", item.emoji || "");
      if (v === null) return;
      item.emoji = v.trim() ? pickEmoji(v) : null;
      if (v.trim() && !item.emoji) toast("Не увидел эмодзи в этом тексте");
      render();
    };
    card.append(box, emo); grid.append(card);
  });
  $("dropTitle").textContent = items.length ? "Добавить ещё" : "Выбрать фотографии";
  $("clearBtn").disabled = !items.length; $("gridTip").hidden = !items.length;
  $("queueMeta").textContent = items.length ? `${items.length} из ${MAX_STICKERS}` : "Пока ничего нет";
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
  $("createBtn").textContent = items.length ? `Создать стикерпак (${items.length})` : "Создать стикерпак";
  $("createHint").textContent = !connected() ? "Сначала войди через Telegram" : !items.length ? "Выбери фотографии" : $("packTarget").value ? "Стикеры добавятся в выбранный пак" : "Создам новый пак и загружу все стикеры";
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
  if (typeof CompressionStream === "undefined") throw new Error("Браузер слишком старый: обнови iOS до 16.4+ или открой в Chrome");
  const d = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
  const bytes = await quantizedPng(d.data, canvas.width, canvas.height);
  const blob = new Blob([bytes], { type: "image/png" });
  if (blob.size > 512 * 1024) throw new Error("Не удалось уместить файл в 512 КБ");
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
  let title = (prefs.title || "").trim() || "Мой стикерпак";
  let queue = items.slice();
  $("progressPanel").hidden = false; $("resultPanel").hidden = true; $("log").innerHTML = "";
  $("stopBtn").disabled = false; $("barFill").style.width = "0%"; $("progressTitle").textContent = "Создаю пак…"; $("progressMeta").textContent = "";
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
      if (room <= 0) throw new ApiError("В этом паке уже максимум стикеров (120)", 400);
      if (queue.length > room) { queue = queue.slice(0, room); toast(`В паке место ещё на ${room} — загружу первые ${room}`); }
    }
    for (let i = 0; i < queue.length; i++) {
      if (stopRequested) break;
      const item = queue[i];
      $("progressMeta").textContent = `Стикер ${i + 1} из ${queue.length}`;
      try {
        const { blob, ext } = await processFile(item.file, opts);
        const emoji = pickEmoji(item.emoji) || emojiDefault, filename = `sticker_${i + 1}.${ext}`;
        if (!created) { const r = await sendSticker("/api/pack/create", { title, emoji }, blob, filename); name = r.name; link = r.link; created = true; }
        else await sendSticker("/api/pack/add", { name, emoji }, blob, filename);
        ok++; addLog(`✓ ${i + 1}. ${item.file.name}`);
      } catch (e) {
        failed++; addLog(`✗ ${i + 1}. ${item.file.name}: ${explain(e.message)}`, true);
        if (fatal(e)) { fatalError = e; break; }
      }
      $("barFill").style.width = Math.round(((i + 1) / queue.length) * 100) + "%";
      await sleep(250);
    }
  } catch (e) { fatalError = e; addLog("✗ " + explain(e.message), true); }
  finally { window.removeEventListener("beforeunload", guard); try { await wake?.release(); } catch { /* ignore */ } }

  busy = false; $("stopBtn").disabled = true;
  if (fatalError && fatalError.status === 401) { session.user = null; renderConnect(); mountWidget(); toast("Сессия закончилась. Войди заново."); }
  if (created && ok > 0) {
    if (!link) link = `https://t.me/addstickers/${name}`;
    let total = null; try { total = (await apiFetch(`/api/pack/info?name=${encodeURIComponent(name)}`)).count; } catch { /* ignore */ }
    const rec = packs.find(p => p.name === name);
    if (rec) rec.count = total ?? ((rec.count || 0) + ok); else packs.unshift({ name, title, count: total ?? ok, date: Date.now() });
    savePacks(); refreshTargets(); renderHistory();
    $("progressTitle").textContent = stopRequested ? "Остановлено" : "Загрузка завершена";
    $("resultTitle").textContent = isNew ? "Стикерпак создан" : "Стикеры добавлены";
    let meta = `Загружено: ${ok}` + (failed ? `, не загрузилось: ${failed}` : "");
    if (total !== null) meta += `. Сейчас в паке ${total} ${plural(total, "стикер", "стикера", "стикеров")}`;
    if (!isNew && total !== null && total < before + ok) meta += ". Telegram показывает меньше, чем ушло: подожди минуту";
    $("resultMeta").textContent = meta;
    $("resultLink").href = link; $("resultPanel").hidden = false; $("resultPanel").dataset.link = link;
    $("resultPanel").scrollIntoView({ behavior: "smooth", block: "start" });
    items.forEach(x => URL.revokeObjectURL(x.url)); items = []; render();
  } else {
    $("progressTitle").textContent = "Не получилось";
    $("progressMeta").textContent = fatalError ? explain(fatalError.message) : stopRequested ? "Остановлено до создания пака" : "Ни один стикер не загрузился — причины в списке ниже";
  }
  updateCreateState();
}
$("createBtn").onclick = createPack;
$("stopBtn").onclick = () => { stopRequested = true; $("stopBtn").disabled = true; $("progressMeta").textContent = "Останавливаю после текущего стикера…"; };
$("copyLinkBtn").onclick = async () => { const link = $("resultPanel").dataset.link; if (!link) return; try { await navigator.clipboard.writeText(link); toast("Ссылка скопирована"); } catch { prompt("Скопируй ссылку:", link); } };

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
    const a = document.createElement("a"); a.href = `https://t.me/addstickers/${p.name}`; a.target = "_blank"; a.rel = "noopener"; a.textContent = "Открыть";
    li.append(pk, a); ul.append(li);
  }
}

// ---------- settings ----------
$("settingsBtn").onclick = () => { $("settingsModal").hidden = false; };
$("closeModal").onclick = () => { $("settingsModal").hidden = true; };
$("settingsModal").addEventListener("click", e => { if (e.target === $("settingsModal")) $("settingsModal").hidden = true; });
$("resetAll").onclick = () => { if (confirm("Стереть настройки и список паков в этом браузере? Сами паки в Telegram останутся.")) { Object.keys(localStorage).filter(k => k.startsWith("sf2_")).forEach(k => localStorage.removeItem(k)); location.reload(); } };

// ---------- init ----------
renderPrefs(); render();
loadSession();
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("./sw.js").catch(() => {});
