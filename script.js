"use strict";
/* ===================== StudyPal — Improved Single-File JS =====================
   Drop-in replacement. Keeps the same element IDs and public function names.
   Major upgrades: safer DOM writes, debounced saves, crypto shuffle, fuzzy typed
   answers, spaced-repetition scheduling, export/import of full backup, keyboard
   shortcuts, TTS voice controls, settings/theme polish, undo delete, versioned
   storage migrations.                                                     */

/* ---------- State & helpers ---------- */
const DB = { title: "StudyPal Deck", cards: [], notes: "" };
let quizIdx = 0, score = 0; // legacy counters kept for compatibility

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const esc = (s) => String(s || "").replace(/[&<>"']/g, (m) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[m]));

// Versioned LocalStorage
const KEY = "study-buddy-v1";          // same key for DB (with __ver)
const SP_KEY = "studypal_spaced_rep_v1"; // SR state
const STORE_VER = 2; // bump when schema changes

function safeSetLS(k, v){ try { localStorage.setItem(k, v); } catch {} }
function safeGetLS(k){ try { return localStorage.getItem(k); } catch { return null; } }

// Debounce helper
const debounce = (fn, ms = 200) => { let t; return (...a)=>{ clearTimeout(t); t = setTimeout(()=>fn(...a), ms); }; };

function save() {
  safeSetLS(KEY, JSON.stringify({ ...DB, __ver: STORE_VER }));
  const st = $("#status");
  if (st) { st.textContent = "Saved"; setTimeout(() => st.textContent = "", 800); }
}
const saveDebounced = debounce(save, 200);

function load() {
  try {
    const raw = JSON.parse(safeGetLS(KEY) || "null");
    if (raw && Array.isArray(raw.cards)) {
      let data = raw;
      const ver = raw.__ver || 1;
      if (ver === 1) {
        // Migration: ensure tags is array
        data.cards = data.cards.map(c => ({ ...c, tags: Array.isArray(c.tags) ? c.tags : [] }));
        data.__ver = 2;
      }
      Object.assign(DB, data);
    }
  } catch {}
}

/* ---------- Notes → Cards generator (basic & smart) ---------- */
function notesToCards(text) {
  const sentences = text.replace(/\n+/g, " ")
    .split(".")
    .map(s => s.trim())
    .filter(Boolean);
  const cards = sentences.slice(0, 12).map((s, i) => ({
    q: `Card ${i + 1}: ${(s.split(" ")[0] || "").replace(/[^\w()-]/g, "")}…?`,
    a: s.slice(0, 220),
    tags: ["auto"]
  }));
  if (!cards.length) {
    cards.push({ q: "What is the main idea?", a: text.slice(0, 200) || "No notes yet.", tags: ["summary"] });
    cards.push({ q: "Name one key term.", a: "Example term", tags: ["recall"] });
  }
  return cards;
}

// Smart generator (term: def, Q:/A:, headings, cloze)
function spHash(str) {
  let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24); }
  return (h >>> 0).toString(36);
}
function cardId(c) { return spHash((c.q || "") + "::" + (c.a || "")); }
function toCloze(s){
  const words = s.match(/[A-Za-z][A-Za-z0-9\-]+/g) || [];
  const pick = words.sort((a,b)=>b.length-a.length).find(w=>w[0]===w[0].toUpperCase()) || words[0];
  if (!pick) return { q: s, a: s };
  const q = s.replace(new RegExp(`\\b${pick}\\b`, 'g'), '_____');
  return { q, a: pick };
}
function smartNotesToCards(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const pairs = [];
  // Q:/A:
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (/^q[:\-]/i.test(L)) {
      const q = L.replace(/^q[:\-]\s*/i, "");
      const aLine = (lines[i+1] || "");
      if (/^a[:\-]/i.test(aLine)) {
        const a = aLine.replace(/^a[:\-]\s*/i, "");
        pairs.push({ q, a, tags: ["smart","Q/A"] }); i++; continue;
      }
    }
  }
  // term: def
  lines.forEach(L => {
    const m = L.match(/^(.{2,80}?)[\s]*[:\-—–]+[\s]+(.{3,})$/);
    if (m && !/^q[:\-]/i.test(L) && !/^a[:\-]/i.test(L)) {
      const term = m[1].trim(); const def = m[2].trim();
      if (term && def) pairs.push({ q: `What is ${term}?`, a: def, tags: ["smart","term"] });
    }
  });
  // Headings -> next
  lines.forEach((L,i)=>{
    const hm = /^#{1,6}\s+(.+)$/.exec(L) || /^\*\*?(.+?)\*\*?$/.exec(L);
    if (hm) {
      const head = (hm[1]||"").trim(); const next = lines[i+1] || "";
      if (head && next) pairs.push({ q: `Explain: ${head}`, a: next.slice(0,240), tags:["smart","heading"] });
    }
  });
  // Fallback: cloze
  const sentences = text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/).map(s=>s.trim()).filter(s=>s.length>16);
  sentences.slice(0,30).forEach((s)=>{ const c = toCloze(s); pairs.push({ q: c.q, a: c.a, tags:["smart","cloze"] }); });
  // dedupe
  const seen = new Set(); const out = [];
  for (const p of pairs) { const id = cardId(p); if (!seen.has(id)) { out.push(p); seen.add(id); } }
  return out.slice(0, 60);
}

/* ---------- Text-to-Speech with voice controls ---------- */
const TTS = { rate: 1.0, pitch: 1.0, voice: null };
function initVoices(){
  try {
    const voices = speechSynthesis.getVoices();
    TTS.voice = voices.find(v=>/en/i.test(v.lang)) || voices[0] || null;
  } catch {}
}
if ('speechSynthesis' in window) { speechSynthesis.onvoiceschanged = initVoices; initVoices(); }
function speak(text) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    if (TTS.voice) u.voice = TTS.voice; u.rate = TTS.rate; u.pitch = TTS.pitch;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  } catch {}
}

/* ---------- Spaced Repetition (boxes + scheduling) ---------- */
let SR = {};
function loadSR(){ try { SR = JSON.parse(safeGetLS(SP_KEY) || "{}"); } catch { SR = {}; } }
function saveSR(){ safeSetLS(SP_KEY, JSON.stringify(SR)); }
function getBox(id){ return (SR[id]?.box) || 1; }
const SR_INTERVALS_MS = { 1: 0, 2: 24*3600e3, 3: 3*24*3600e3, 4: 7*24*3600e3, 5: 21*24*3600e3 };
function isDue(id, now = Date.now()){
  const st = SR[id]; if (!st) return true; const gap = SR_INTERVALS_MS[st.box] ?? 0; return (now - (st.lastTs||0)) >= gap;
}
function bump(id, correct){
  const now = Date.now(); const cur = SR[id] || { box: 1, streak: 0, lastTs: 0 };
  if (correct) { cur.streak = (cur.streak||0) + 1; cur.box = Math.min(5, cur.box + 1); }
  else { cur.streak = 0; cur.box = 1; }
  cur.lastTs = now; SR[id] = cur; saveSR();
}
function srSummaryText(cards){
  const counts = [0,0,0,0,0,0]; cards.forEach(c => counts[getBox(cardId(c))]++);
  return counts.slice(1).map((n,i)=>`<span class="sr-badge">Box ${i+1}: ${n}</span>`).join(" ");
}

/* ---------- Utilities ---------- */
function cryptoShuffle(arr){
  const a = arr.slice();
  const rnd = (max) => {
    if (window.crypto?.getRandomValues) { const u32 = new Uint32Array(1); window.crypto.getRandomValues(u32); return u32[0] / 2**32 * max; }
    return Math.random() * max;
  };
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd(i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const toFixed6 = (n) => Math.round(n * 1e6) / 1e6;
const extractNumbers = (q) => (q.match(/-?\d+(\.\d+)?/g) || []).map(Number);

/* ---------- Cards: render + edit/delete/reorder + TTS ---------- */
function renderCards() {
  const wrap = $("#cards"); if (!wrap) return;
  const html = DB.cards.map((c, i) => `
    <div class="card" data-i="${i}">
      <div><b>Q${i + 1}:</b> ${esc(c.q)} ${!document.body.classList.contains('hide-tags') ? `<span class="tag">${(c.tags||[]).map(esc).join(" • ")}</span>` : ''}</div>
      <div><b>A:</b> ${esc(c.a)}</div>
      <div class="actions">
        <button class="edit">Edit</button>
        <button class="del">Delete</button>
        <button class="speakQ" aria-label="Speak Question">🔊 Q</button>
        <button class="speakA" aria-label="Speak Answer">🔊 A</button>
        <button class="up">↑</button>
        <button class="down">↓</button>
      </div>
    </div>
  `).join("");
  wrap.innerHTML = html || '<p class="muted">No cards yet.</p>';

  let lastDeleted = null;
  wrap.querySelectorAll(".card").forEach(card => {
    const i = +card.dataset.i;
    card.querySelector(".edit").onclick = () => editCard(i);
    card.querySelector(".del").onclick = () => {
      lastDeleted = { i, c: DB.cards[i] }; DB.cards.splice(i,1); renderCards(); save();
      const bar = $("#status"); if (bar) { bar.innerHTML = `Card deleted. <button id="undoDel">Undo</button>`; const u = $("#undoDel"); if (u) u.onclick = () => { if (lastDeleted){ DB.cards.splice(lastDeleted.i,0,lastDeleted.c); lastDeleted=null; renderCards(); save(); bar.textContent="Restored."; } }; }
    };
    card.querySelector(".speakQ").onclick = () => speak(DB.cards[i].q);
    card.querySelector(".speakA").onclick = () => speak(DB.cards[i].a);
    card.querySelector(".up").onclick = () => { if (i > 0) { [DB.cards[i - 1], DB.cards[i]] = [DB.cards[i], DB.cards[i - 1]]; renderCards(); save(); } };
    card.querySelector(".down").onclick = () => { if (i < DB.cards.length - 1) { [DB.cards[i + 1], DB.cards[i]] = [DB.cards[i], DB.cards[i + 1]]; renderCards(); save(); } };
  });
}

function editCard(i) {
  const c = DB.cards[i]; if (!c) return;
  const q = prompt("Edit question:", c.q); if (q === null) return;
  const a = prompt("Edit answer:", c.a); if (a === null) return;
  DB.cards[i] = { ...c, q, a }; renderCards(); save();
}

/* ---------- Simple Quiz (kept for backward compatibility) ---------- */
function updateProgress() {
  const bar = $("#quizProgress .bar"); if (!bar) return;
  const total = Math.min(5, DB.cards.length) || 1; const pct = Math.min(100, Math.round((quizIdx / total) * 100)); bar.style.width = pct + "%";
}

function startQuiz() { // legacy button will call this; it will internally delegate to startQuizPlus
  if ($("#optLen") || $("#btnSaveSettings")) { startQuizPlus(); return; }
  const qz = $("#quiz"); if (!qz) return;
  if (!DB.cards.length) { qz.innerHTML = "<p class='muted'>Generate cards first.</p>"; return; }
  quizIdx = 0; score = 0; showQuestion(); updateProgress();
}

function showQuestion() {
  const qz = $("#quiz"); const total = Math.min(5, DB.cards.length);
  if (quizIdx >= total) {
    qz.innerHTML = `<p><b>Done!</b> Score ${score}/${total}</p>`; if (score === total) celebrate(); updateProgress(); return;
  }
  const c = DB.cards[quizIdx];
  const pool = DB.cards.map(x => x.a).filter(a => a !== c.a);
  const choices = cryptoShuffle([c.a, ...pool.slice(0, 2)]);
  qz.innerHTML = `
    <div class="card">
      <b>${esc(c.q)}</b>
      ${choices.map(ch => `
        <div><label><input type="radio" name="opt" value="${esc(ch)}"> ${esc(ch)}</label></div>
      `).join("")}
      <div class="actions"><button id="submit">Submit</button></div>
    </div>
  `;
  $("#submit").onclick = () => {
    const pick = document.querySelector('input[name="opt"]:checked'); if (!pick) { alert("Pick one!"); return; }
    if (pick.value === c.a) score++;
    quizIdx++; updateProgress(); showQuestion();
  };
}

function celebrate() {
  const layer = document.createElement("div"); layer.style.position = "fixed"; layer.style.inset = 0; layer.style.pointerEvents = "none"; document.body.appendChild(layer);
  Array.from({ length: 40 }).forEach(() => {
    const e = document.createElement("div"); e.textContent = "🎉"; e.style.position = "absolute"; e.style.left = Math.random() * 100 + "vw"; e.style.top = "-10vh"; e.style.fontSize = (16 + Math.random() * 20) + "px"; e.style.transition = "transform 1.2s ease, opacity 1.2s ease"; layer.appendChild(e);
    requestAnimationFrame(() => { e.style.transform = `translateY(${110 + Math.random() * 30}vh) rotate(${(Math.random() * 720 - 360) | 0}deg)`; e.style.opacity = "0"; });
  });
  setTimeout(() => layer.remove(), 1400);
}

/* ---------- Import / Export ---------- */
function exportDeck() {
  const deck = { deck_title: DB.title, cards: DB.cards };
  const blob = new Blob([JSON.stringify(deck, null, 2)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "deck.json"; a.click();
}
function exportAll() {
  const blob = new Blob([JSON.stringify({
    deck: { title: DB.title, cards: DB.cards },
    sr: SR, settings: SB.settings, stats: SB.stats,
    exportedAt: new Date().toISOString(), ver: 1
  }, null, 2)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "studypal_backup.json"; a.click();
}
function isCard(x){ return x && typeof x.q === "string" && typeof x.a === "string"; }
function importDeck() {
  const inp = document.createElement("input"); inp.type = "file"; inp.accept = "application/json";
  inp.onchange = async () => {
    const file = inp.files[0]; if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (Array.isArray(data.cards) && data.cards.every(isCard)) {
        DB.cards = data.cards.slice(0, 1000); DB.title = String(data.deck_title || DB.title).slice(0,120);
        renderCards(); save();
      } else alert("Invalid deck file");
    } catch { alert("Could not read deck"); }
  };
  inp.click();
}

/* ---------- Dark Mode ---------- */
function toggleDark() {
  document.documentElement.classList.toggle("dark");
  try { safeSetLS("sb-dark", document.documentElement.classList.contains("dark") ? "1" : "0"); } catch {}
  updateDarkLabel();
}
function initDark() {
  try { if (safeGetLS("sb-dark") === "1") document.documentElement.classList.add("dark"); } catch {}
  updateDarkLabel();
}
function updateDarkLabel() {
  const btnDark = $("#btnDark"); if (!btnDark) return;
  const isDark = document.documentElement.classList.contains("dark");
  btnDark.textContent = isDark ? "☀️ Light mode" : "🌙 Dark mode";
}

/* ---------- Assistant helpers (math/CS/BA + notes/cards) ---------- */
const KNOWLEDGE = {
  photosynthesis: "Photosynthesis: plants use sunlight, water, and CO₂ to make glucose and release oxygen.",
  mitosis: "Mitosis: cell division producing two identical daughter cells (prophase → metaphase → anaphase → telophase).",
  "world war 2": "World War II (1939–1945): global conflict between Allies and Axis; major theaters in Europe and the Pacific.",
  pi: "Pi (π) ≈ 3.14159… ratio of a circle’s circumference to its diameter.",
  atom: "Atom: smallest unit of matter; nucleus (protons, neutrons) with electrons in orbitals."
};

function safeEvalMath(expr) {
  if (!expr) return null; const cleaned = expr.replace(/\s+/g, "");
  if (!/^[0-9().+\-*/^%]+$/.test(cleaned)) return null; const jsExpr = cleaned.replace(/\^/g, "**");
  try { const val = Function("'use strict'; return (" + jsExpr + ");")(); return (typeof val === "number" && isFinite(val)) ? val : null; } catch { return null; }
}
function solveLinear(eq) {
  const s = eq.toLowerCase().replace(/\s+/g, ""); const m = s.match(/(-?\d*\.?\d*)x([+\-]\d*\.?\d*)?=(-?\d*\.?\d*)/);
  if (!m) return null; let a = m[1]; a = (a === "" || a === "+") ? 1 : (a === "-" ? -1 : parseFloat(a));
  const b = parseFloat(m[2] || "0"); const c = parseFloat(m[3] || "0"); const x = (c - b) / a; return `Solving ${m[0]} → x = ${toFixed6(x)}`;
}
function derivativePoly(q) {
  const m = q.toLowerCase().match(/derivative of ([^?]+)/); if (!m) return null; const expr = m[1].replace(/\s+/g, "");
  const terms = expr.replace(/-/g, "+-").split("+").filter(Boolean);
  const derivTerms = terms.map(t => {
    if (!/x/.test(t)) return "0";
    const m1 = t.match(/^(-?\d*\.?\d*)x(?:\^(-?\d+))?$/) || t.match(/^x(?:\^(-?\d+))?$/); if (!m1) return "0";
    let coef, pow; if (m1.length === 3) { coef = (m1[1] === "" || m1[1] === "+") ? 1 : (m1[1] === "-" ? -1 : parseFloat(m1[1])); pow = m1[2] ? parseFloat(m1[2]) : 1; }
    else { coef = 1; pow = 1; } const newCoef = coef * pow; const newPow = pow - 1;
    if (newPow === 0) return String(newCoef); if (newPow === 1) return `${newCoef}x`; return `${newCoef}x^${newPow}`;
  });
  const pretty = derivTerms.filter(t => t !== "0").map((t, i) => (t.startsWith("-") || i === 0) ? t : `+${t}`).join(" ");
  return `d/dx(${m[1].trim()}) = ${pretty || "0"}`;
}
function statsHelper(q) {
  const nums = extractNumbers(q); if (nums.length < 2) return null; const n = nums.length; const mean = nums.reduce((a,b)=>a+b,0)/n;
  const sorted = nums.slice().sort((a,b)=>a-b); const median = (n%2 ? sorted[(n-1)/2] : (sorted[n/2-1]+sorted[n/2])/2);
  const variance = nums.reduce((s,x)=>s + Math.pow(x-mean,2),0)/n; const std = Math.sqrt(variance);
  return `Numbers: [${nums.join(", ")}]\nMean = ${toFixed6(mean)}, Median = ${toFixed6(median)}, Std Dev = ${toFixed6(std)}`;
}
function csComplexity(q) {
  const s = q.toLowerCase();
  if (s.includes("binary search")) return "Binary search: O(log n) time, O(1) space (sorted array).";
  if (s.includes("hash map") || s.includes("hashtable")) return "Hash map: average O(1) insert/lookup, worst-case O(n).";
  if (s.includes("quicksort")) return "Quicksort: average O(n log n), worst-case O(n^2), ~O(log n) space (recursion).";
  if (s.includes("mergesort")) return "Mergesort: O(n log n) time, O(n) extra space.";
  if (s.includes("bfs") || s.includes("breadth")) return "BFS on graph: O(V+E) time, O(V) space.";
  if (s.includes("dfs") || s.includes("depth")) return "DFS on graph: O(V+E) time, O(V) space.";
  if (s.includes("two pointers")) return "Two pointers: typically O(n) time, O(1) space for linear scans on arrays/strings.";
  return null;
}
function sqlHelper(q) {
  const s = q.toLowerCase();
  if (s.includes("sql") || s.includes("query") || s.includes("select")) {
    return `SQL patterns:\n• Count by group:\nSELECT group_col, COUNT(*) AS cnt\nFROM your_table\nGROUP BY group_col;\n\n• Conversion rate:\nSELECT SUM(CASE WHEN converted=1 THEN 1 ELSE 0 END)*1.0/COUNT(*) AS conversion_rate\nFROM events;\n\n• Top N:\nSELECT item, COUNT(*) AS uses\nFROM logs\nGROUP BY item\nORDER BY uses DESC\nLIMIT 10;`;
  }
  return null;
}
function bizAnalytics(q) {
  const s = q.toLowerCase();
  if (s.includes("conversion rate")) return "Conversion Rate = Conversions / Total Visitors. ×100% for a percent.";
  if (s.includes("ltv") || s.includes("lifetime value")) return "LTV ≈ ARPU × Gross Margin × Avg Customer Lifespan. For subs: LTV ≈ ARPU × (Gross Margin) / Churn.";
  if (s.includes("cac")) return "CAC = Total marketing/sales spend / # of new customers.";
  if (s.includes("arpu")) return "ARPU = Total revenue / Active users in a period.";
  if (s.includes("a/b") || s.includes("ab test")) return "A/B test: pick metric, randomize split, run long enough, compute lift & CI/p-value; beware peeking.";
  if (s.includes("cohort")) return "Cohort analysis: group users by start time/event (e.g., signup month) and track retention/revenue over time.";
  return null;
}

/* ---------- Assistant UI & logic ---------- */
function chatAdd(text, who) {
  const box = $("#assistantOutput"); if (!box) return;
  const div = document.createElement("div"); div.className = "msg " + (who || "ai");
  div.textContent = (who === "me" ? "You: " : "AI: ") + text; box.appendChild(div); box.scrollTop = box.scrollHeight;
}
function askAssistant() {
  const input = $("#assistantInput"); if (!input) return;
  const q = input.value.trim(); if (!q) return; input.value = ""; chatAdd(q, "me");
  if (/[0-9][0-9().+\-*/^% ]+$/.test(q)) { const val = safeEvalMath(q); if (val !== null) { chatAdd(`Result: ${toFixed6(val)}`, "ai"); return; } }
  if (/solve/i.test(q) && /x/i.test(q) && /=/.test(q)) { const ans = solveLinear(q); if (ans) { chatAdd(ans, "ai"); return; } }
  if (/derivative of/i.test(q)) { const d = derivativePoly(q); if (d) { chatAdd(d, "ai"); return; } }
  if (/mean|average|median|std|standard deviation/i.test(q)) { const s = statsHelper(q); if (s) { chatAdd(s, "ai"); return; } }
  const cs = csComplexity(q); if (cs) { chatAdd(cs, "ai"); return; }
  const sql = sqlHelper(q); if (sql) { chatAdd(sql, "ai"); return; }
  const ba = bizAnalytics(q); if (ba) { chatAdd(ba, "ai"); return; }
  const words = q.toLowerCase().split(/\W+/).filter(w => w.length > 3);
  const found = DB.cards.find(c => words.some(w => c.a.toLowerCase().includes(w) || c.q.toLowerCase().includes(w)));
  if (found) { chatAdd("From your notes: " + found.a, "ai"); return; }
  for (const key in KNOWLEDGE) { if (q.toLowerCase().includes(key)) { chatAdd(KNOWLEDGE[key], "ai"); return; } }
  chatAdd("I’m not sure yet — try adding notes or ask topics like derivatives, binary search, conversion rate, or SQL SELECT.", "ai");
}

/* ---------- Pro Quiz (MC or typed) + Fuzzy matching + Due-first queue ---------- */
const SB = { settingsKey: "sb-settings-v1", statsKey: "sb-stats-v1", settings: { quizLen: 5, mode: "mc", shuffle: true, showTags: false, cardSize: "comfy", accent: "#4facfe" }, stats: { totalAnswered: 0, totalCorrect: 0, streak: 0 } };
(function loadSettingsAndStats(){ try { const s = JSON.parse(safeGetLS(SB.settingsKey) || "null"); if (s) SB.settings = { ...SB.settings, ...s }; } catch {}
  try { const t = JSON.parse(safeGetLS(SB.statsKey) || "null"); if (t) SB.stats = { ...SB.stats, ...t }; } catch {} })();
function saveSettings(){ safeSetLS(SB.settingsKey, JSON.stringify(SB.settings)); const el=$("#settingsStatus"); if (el){ el.textContent="Settings saved"; setTimeout(()=>el.textContent="",900);} }
function saveStats(){ safeSetLS(SB.statsKey, JSON.stringify(SB.stats)); }
function applySettingsToTheme(){
  document.documentElement.style.setProperty("--accent", SB.settings.accent);
  try { const c = SB.settings.accent.replace("#", ""); const r = parseInt(c.substring(0,2),16), g=parseInt(c.substring(2,4),16), b=parseInt(c.substring(4,6),16); const lighten = (x)=> Math.min(255, Math.round(x + (255-x)*0.4)); const c2 = `#${lighten(r).toString(16).padStart(2,"0")}${lighten(g).toString(16).padStart(2,"0")}${lighten(b).toString(16).padStart(2,"0")}`; document.documentElement.style.setProperty("--accent-2", c2);} catch {}
  document.body.classList.toggle("hide-tags", !SB.settings.showTags);
  document.body.classList.toggle("compact-cards", SB.settings.cardSize === "compact");
}
function normalize(s){ return String(s||"").trim().replace(/\s+/g," ").replace(/[^\w\s]/g,"").toLowerCase(); }
function lev(a,b){ const m=a.length,n=b.length; const d=Array.from({length:m+1},(_,i)=>Array(n+1).fill(0)); for(let i=0;i<=m;i++)d[i][0]=i; for(let j=0;j<=n;j++)d[0][j]=j; for(let i=1;i<=m;i++) for(let j=1;j<=n;j++) d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(a[i-1]===b[j-1]?0:1)); return d[m][n]; }
function typedCorrect(user, truth){ const u = normalize(user), t = normalize(truth); if (!u) return false; const dist = lev(u,t); const tol = Math.max(1, Math.floor(t.length*0.15)); return dist <= tol || t.includes(u); }

function chooseQuizSet(){
  const total = SB.settings.quizLen === "all" ? DB.cards.length : Math.min(parseInt(SB.settings.quizLen||5,10), DB.cards.length);
  let cards = DB.cards.slice();
  // prefer due cards first
  const due = cards.filter(c => isDue(cardId(c))); const rest = cards.filter(c => !isDue(cardId(c)));
  let queue = cryptoShuffle(due).concat(SB.settings.shuffle ? cryptoShuffle(rest) : rest);
  queue = queue.slice(0, Math.max(1,total));
  return queue;
}

let quizSet = []; let quizPointer = 0;
function buildChoicesFor(card, pool, n=3){ const wrong = pool.filter(a => a !== card.a); const picks = []; const W = wrong.slice(); while (picks.length < n-1 && W.length) { const idx = Math.floor(Math.random()*W.length); const w = W.splice(idx,1)[0]; if (!picks.includes(w)) picks.push(w); } return cryptoShuffle([card.a, ...picks]); }

function updateProgressPlus(){ const bar = $("#quizProgress .bar"); if (!bar) return; const total = quizSet.length || 1; const pct = Math.min(100, Math.round((quizPointer / total) * 100)); bar.style.width = pct + "%"; }
function enableMCKeys(containerSelector = "#quiz"){
  const root = document.querySelector(containerSelector); if (!root) return;
  root.onkeydown = (e)=>{
    const opts=[...root.querySelectorAll('.pro-opt, input[name="opt"]')]; if (!opts.length) return;
    const cur=opts.findIndex(o=>o.classList?.contains('focused') || (o.checked===true));
    const step=(d)=>{ let i=(cur<0?0:(cur+d+opts.length)%opts.length); opts.forEach(o=>o.classList?.remove('focused')); const el = opts[i].closest('.pro-opt') || opts[i]; el.classList?.add('focused'); (el.querySelector('input')||el).focus(); };
    if (e.key==='ArrowDown'||e.key==='ArrowRight'){ step(+1); e.preventDefault(); }
    if (e.key==='ArrowUp'||e.key==='ArrowLeft'){ step(-1); e.preventDefault(); }
    if (e.key==='Enter'){ const sub = root.querySelector('#submitPlus,#submit'); if (sub) sub.click(); }
  };
}

function renderQuestionPlus(){
  const qz = $("#quiz"); const total = quizSet.length; if (!qz) return;
  if (quizPointer >= total) { qz.innerHTML = `<p><b>Done!</b> Score ${score}/${total} — Accuracy ${(score*100/total).toFixed(0)}%</p>`; if (score === total) celebrate(); updateProgressPlus(); const el=$("#srSummary"); if (el) el.innerHTML = srSummaryText(DB.cards); return; }
  const c = quizSet[quizPointer]; const poolAnswers = quizSet.map(x=>x.a); const isTyped = SB.settings.mode === "typed";
  const body = [];
  body.push(`<div class="card">`); body.push(`<div class="pro-question">${esc(c.q)}</div>`);
  if (isTyped) { body.push(`<input id="typedAns" class="quiz-typed-input ask" type="text" placeholder="Type your answer…" />`); }
  else { const choices = buildChoicesFor(c, poolAnswers, 4); body.push(choices.map(o => `<div class="pro-opt" data-v="${esc(o)}"><label><input type="radio" name="opt" value="${esc(o)}"> ${esc(o)}</label></div>`).join("")); }
  body.push(`<div class="pro-actions"><button id="submitPlus">Submit</button><button id="revealPlus" class="ghost">Reveal</button><button id="btnSkip" class="ghost">Skip</button></div><div id="feedback" class="quiz-feedback" aria-live="polite"></div></div>`);
  qz.innerHTML = body.join("");

  $("#revealPlus").onclick = () => { const fb=$("#feedback"); if (fb){ fb.textContent = `Answer: ${c.a}`; fb.className = "quiz-feedback"; } };
  $("#btnSkip").onclick = () => { bump(cardId(c), false); quizPointer++; updateProgressPlus(); renderQuestionPlus(); };

  $("#submitPlus").onclick = () => {
    let correct = false; if (isTyped) { const v = $("#typedAns").value; correct = typedCorrect(v, c.a); } else { const pick = document.querySelector('input[name="opt"]:checked'); if (!pick) { alert("Pick one!"); return; } correct = (pick.value === c.a); }
    const fb=$("#feedback"); if (correct) { score++; SB.stats.totalCorrect++; SB.stats.streak++; fb && (fb.textContent = "Correct! 🎉", fb.className = "quiz-feedback ok"); bump(cardId(c), true); }
    else { SB.stats.streak = 0; fb && (fb.textContent = `Not quite. Correct answer: ${c.a}`, fb.className = "quiz-feedback no"); bump(cardId(c), false); }
    SB.stats.totalAnswered++; saveStats(); setTimeout(()=>{ quizPointer++; updateProgressPlus(); renderQuestionPlus(); }, 550);
  };
  enableMCKeys();
}

function startProQuiz(){ // kept for compatibility with #btnStartPro
  if (!DB.cards.length) { const qz=$("#quiz"); if (qz) qz.innerHTML = "<p class='muted'>Generate cards first.</p>"; return; }
  score = 0; quizSet = chooseQuizSet(); quizPointer = 0; renderQuestionPlus(); updateProgressPlus(); const el=$("#srSummary"); if (el) el.innerHTML = srSummaryText(DB.cards);
}
function startQuizPlus(){ startProQuiz(); }

/* ---------- Wire up UI ---------- */
function setup() {
  load(); loadSR(); initDark(); applySettingsToTheme();
  const notes = $("#notes"); if (notes) { notes.value = DB.notes || ""; notes.addEventListener("input", () => { DB.notes = notes.value; saveDebounced(); }); }
  renderCards();
  const btnGen = $("#btnGen"); if (btnGen) btnGen.onclick = () => { DB.notes = ($("#notes")?.value || ""); DB.cards = notesToCards(DB.notes); renderCards(); save(); const st=$("#status"); if (st) st.textContent = `Generated ${DB.cards.length} cards.`; const tip=$("#genTip"); if (tip) tip.classList.remove("hidden"); };
  const btnQuiz = $("#btnQuiz"); if (btnQuiz) btnQuiz.onclick = startQuizPlus;
  const btnExport = $("#btnExport"); if (btnExport) btnExport.onclick = exportDeck;
  const btnImport = $("#btnImport"); if (btnImport) btnImport.onclick = importDeck;
  const btnDark = $("#btnDark"); if (btnDark) btnDark.onclick = toggleDark;
  const send = $("#assistantSend"); if (send) send.onclick = askAssistant;
  const input = $("#assistantInput"); if (input) input.addEventListener("keydown", (e) => { if (e.key === "Enter") askAssistant(); });
  const btnSmart = $("#btnSmartGen"); if (btnSmart) btnSmart.onclick = () => { const notesVal = ($("#notes")?.value || "").trim(); if (!notesVal) { alert("Paste notes first."); return; } const cards = smartNotesToCards(notesVal); if (!cards.length) { alert("Couldn't detect Q/A pairs. Try lines like 'Term — definition'."); return; } const existingIds = new Set(DB.cards.map(cardId)); const merged = DB.cards.concat(cards.filter(c => !existingIds.has(cardId(c)))); DB.cards = merged; renderCards(); save(); const st=$("#status"); if (st) st.textContent = `Smart-generated ${cards.length} new cards (merged to ${DB.cards.length}).`; const el=$("#srSummary"); if (el) el.innerHTML = srSummaryText(DB.cards); };
  const btnStartPro = $("#btnStartPro"); if (btnStartPro) btnStartPro.onclick = startProQuiz;
  const btnReset = $("#btnResetProgress"); if (btnReset) btnReset.onclick = () => { if (confirm("Reset spaced-repetition progress?")) { SR = {}; saveSR(); const el=$("#srSummary"); if (el) el.innerHTML = srSummaryText(DB.cards); alert("Progress reset."); } };
  const optLen = $("#optLen"), optMode=$("#optMode"), optShuffle=$("#optShuffle"), optShowTags=$("#optShowTags"), optCardSize=$("#optCardSize"), optAccent=$("#optAccent");
  if (optLen) optLen.value = String(SB.settings.quizLen);
  if (optMode) optMode.value = SB.settings.mode;
  if (optShuffle) optShuffle.checked = !!SB.settings.shuffle;
  if (optShowTags) optShowTags.checked = !!SB.settings.showTags;
  if (optCardSize) optCardSize.value = SB.settings.cardSize;
  if (optAccent) optAccent.value = SB.settings.accent;
  const btnSave = $("#btnSaveSettings"); if (btnSave) btnSave.onclick = () => { SB.settings.quizLen = (optLen ? (optLen.value === "all" ? "all" : parseInt(optLen.value,10)||5) : 5); SB.settings.mode = optMode ? optMode.value : "mc"; SB.settings.shuffle = optShuffle ? !!optShuffle.checked : true; SB.settings.showTags = optShowTags ? !!optShowTags.checked : false; SB.settings.cardSize = optCardSize ? optCardSize.value : "comfy"; SB.settings.accent = optAccent ? optAccent.value : "#4facfe"; saveSettings(); applySettingsToTheme(); };
  const btnResetStats = $("#btnResetStats"); if (btnResetStats) btnResetStats.onclick = () => { SB.stats = { totalAnswered: 0, totalCorrect: 0, streak: 0 }; saveStats(); const el=$("#settingsStatus"); if (el){ el.textContent = "Stats reset"; setTimeout(()=> el.textContent = "", 900); } };
  // initial SR summary
  const el = $("#srSummary"); if (el) el.innerHTML = srSummaryText(DB.cards);
  console.log("[StudyPal] Ready");
}

document.addEventListener("DOMContentLoaded", setup);

/* ===== MVP add-ons kept (tip + dark label already wired) ===== */
(function initMvpAddons(){ if (document.readyState !== "loading") { updateDarkLabel(); const btnGen=$("#btnGen"), tip=$("#genTip"); if (btnGen && tip) btnGen.addEventListener("click", ()=> tip.classList.remove("hidden")); } else { document.addEventListener("DOMContentLoaded", () => { updateDarkLabel(); const btnGen=$("#btnGen"), tip=$("#genTip"); if (btnGen && tip) btnGen.addEventListener("click", ()=> tip.classList.remove("hidden")); }); }})();

// Expose some functions globally for buttons wired via HTML attributes if any
window.toggleDark = toggleDark; window.exportDeck = exportDeck; window.importDeck = importDeck; window.startQuiz = startQuiz; window.startProQuiz = startProQuiz; window.startQuizPlus = startQuizPlus; window.askAssistant = askAssistant; window.speak = speak; window.exportAll = exportAll;



