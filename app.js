/* ═══════════════════════════════════════════════════════════════
   EDIT THIS BLOCK — everything else works as-is
   ═══════════════════════════════════════════════════════════════ */
const firebaseConfig = {
  apiKey: "AIzaSyBFj95AmxGCY01nBsQCnCD3kYhxUh6lklA",
  authDomain: "daily-planner-db712.firebaseapp.com",
  projectId: "daily-planner-db712",
  storageBucket: "daily-planner-db712.firebasestorage.app",
  messagingSenderId: "894061657165",
  appId: "1:894061657165:web:b73655157c89fce5c9f004"
};

/* ═══════════════════════════════════════════════════════════════ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, signInWithPopup, signInWithRedirect,
  getRedirectResult, GoogleAuthProvider, signOut, setPersistence,
  browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, getDoc, setDoc, collection, addDoc, updateDoc, deleteDoc,
  onSnapshot, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ── init ─────────────────────────────────────────────────────── */
const fbApp = initializeApp(CONFIG.firebase);
const auth  = getAuth(fbApp);
setPersistence(auth, browserLocalPersistence).catch(() => {});

const db = initializeFirestore(fbApp, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = {
  user: null,
  profile: {},
  assignments: [],
  timebox: [],
  view: "home",
  parsed: [],
  tbDate: todayISO(),
  unsubs: []
};

/* ── date helpers (all LOCAL, never UTC) ──────────────────────── */
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function shiftISO(iso, days) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function daysBetween(aISO, bISO) {
  return Math.round((new Date(bISO + "T00:00:00") - new Date(aISO + "T00:00:00")) / 86400000);
}
function prettyDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}
function shortDate(iso) {
  if (!iso) return "No date";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/* ── academic calendar ─────────────────────────────────────────
   Weeks are 5 school days (Mon–Fri by default). The Nth school day
   after termStart is Week ceil(N/perWeek), Day ((N-1) mod perWeek)+1.
   Weekends and dates inside a configured break are skipped.
   ──────────────────────────────────────────────────────────── */
const DEFAULT_SCHOOL_WEEKDAYS = [1, 2, 3, 4, 5]; // Mon..Fri

function academicNow() {
  const today = todayISO();
  const p = state.profile;
  const out = { today, week: null, day: null, breakName: null };

  for (const b of (p.breaks || [])) {
    if (b.start && b.end && today >= b.start && today <= b.end) {
      out.breakName = b.name || "Break";
      break;
    }
  }

  if (!p.termStart || today < p.termStart) return out;

  const schoolWeekdays = DEFAULT_SCHOOL_WEEKDAYS;
  const perWeek = Math.max(1, Number(p.schoolDays) || 5);
  const breaks = p.breaks || [];

  let n = 0;
  let d = p.termStart;
  while (d <= today) {
    const dow = new Date(d + "T00:00:00").getDay();
    const isSchoolDay = schoolWeekdays.includes(dow);
    const inBreak = breaks.some(b => b.start && b.end && d >= b.start && d <= b.end);
    if (isSchoolDay && !inBreak) n++;
    if (d === today) break;
    d = shiftISO(d, 1);
  }

  if (n === 0) return out;
  out.week = Math.ceil(n / perWeek);
  out.day  = ((n - 1) % perWeek) + 1;
  return out;
}

/* Convert "Week N Day M" to a calendar date (used for sanity, not critical) */
function weekDayToISO(weekN, dayM) {
  const p = state.profile;
  if (!p.termStart) return "";
  const perWeek = Math.max(1, Number(p.schoolDays) || 5);
  const target = (weekN - 1) * perWeek + dayM;      // Nth school day
  const breaks = p.breaks || [];
  const schoolWeekdays = DEFAULT_SCHOOL_WEEKDAYS;

  let n = 0;
  let d = p.termStart;
  // Hard cap to avoid runaway loops
  for (let guard = 0; guard < 3000; guard++) {
    const dow = new Date(d + "T00:00:00").getDay();
    const isSchoolDay = schoolWeekdays.includes(dow);
    const inBreak = breaks.some(b => b.start && b.end && d >= b.start && d <= b.end);
    if (isSchoolDay && !inBreak) {
      n++;
      if (n === target) return d;
    }
    d = shiftISO(d, 1);
  }
  return "";
}

function bucketOf(a) {
  if (a.status === "done") return "done";
  const today = todayISO();
  if (!a.due) return "new";
  if (a.due < today) return "old";
  return daysBetween(today, a.due) <= 2 ? "urgent" : "upcoming";
}

/* ── toast ────────────────────────────────────────────────────── */
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ═══════════════════ AUTH ═══════════════════ */
const authError = (m) => {
  const e = $("#authError");
  if (!m) { e.hidden = true; return; }
  e.textContent = m;
  e.hidden = false;
};

$("#btnSignIn").onclick = async () => {
  authError("");
  const email = $("#authEmail").value.trim();
  const pass  = $("#authPassword").value;
  if (!email || !pass) return authError("Enter an email and password.");
  try { await signInWithEmailAndPassword(auth, email, pass); }
  catch (e) { authError(e.message.replace("Firebase: ", "")); }
};

$("#btnSignUp").onclick = async () => {
  authError("");
  const email = $("#authEmail").value.trim();
  const pass  = $("#authPassword").value;
  if (!email || pass.length < 6) return authError("Password must be at least 6 characters.");
  try { await createUserWithEmailAndPassword(auth, email, pass); }
  catch (e) { authError(e.message.replace("Firebase: ", "")); }
};

$("#btnGoogle").onclick = async () => {
  authError("");
  const provider = new GoogleAuthProvider();
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    if (["auth/popup-blocked", "auth/popup-closed-by-user", "auth/operation-not-supported-in-this-environment"].includes(e.code)) {
      try { await signInWithRedirect(auth, provider); }
      catch (e2) { authError(e2.message.replace("Firebase: ", "")); }
    } else {
      authError(e.message.replace("Firebase: ", ""));
    }
  }
};

getRedirectResult(auth).catch(() => {});

$("#btnSignOut").onclick = () => signOut(auth);

onAuthStateChanged(auth, async (user) => {
  state.unsubs.forEach(u => u());
  state.unsubs = [];

  if (!user) {
    state.user = null;
    $("#app").hidden = true;
    $("#authScreen").style.display = "";
    return;
  }

  state.user = user;
  $("#authScreen").style.display = "none";
  $("#app").hidden = false;
  $("#accountEmail").textContent = user.email || "";

  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      termStart: "",
      schoolDays: 5,
      navPosition: "top",
      apiKey: "",
      model: CONFIG.defaultModel,
      breaks: [],
      createdAt: serverTimestamp()
    });
  }

  state.unsubs.push(onSnapshot(ref, (s) => {
    state.profile = s.data() || {};
    applyNavPosition();
    renderHome();
    renderSettings();
    renderTimebox();
  }));

  state.unsubs.push(onSnapshot(collection(db, "users", user.uid, "assignments"), (s) => {
    state.assignments = s.docs.map(d => ({ id: d.id, ...d.data() }));
    renderHome();
    renderAssignments();
    renderTimebox();
  }));

  state.unsubs.push(onSnapshot(collection(db, "users", user.uid, "timebox"), (s) => {
    state.timebox = s.docs.map(d => ({ id: d.id, ...d.data() }));
    renderTimebox();
  }));
});

/* ═══════════════════ NAVIGATION ═══════════════════ */
function applyNavPosition() {
  document.body.className = (state.profile.navPosition === "left") ? "nav-left" : "nav-top";
}

function switchView(v) {
  state.view = v;
  $$(".view").forEach(el => el.classList.toggle("active", el.id === "view-" + v));
  $$(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.view === v));
}
$$(".nav-btn").forEach(b => b.onclick = () => switchView(b.dataset.view));

/* ═══════════════════ RENDER: HOME ═══════════════════ */
function renderHome() {
  const info = academicNow();

  let line = "Today is " + prettyDate(info.today);
  if (info.week) line += ` · Week ${info.week}, Day ${info.day}`;
  $("#homeDate").textContent = line;

  const bb = $("#homeBreak");
  if (info.breakName) {
    bb.hidden = false;
    bb.textContent = "On break: " + info.breakName;
  } else {
    const upcoming = (state.profile.breaks || [])
      .filter(b => b.start && b.start > info.today)
      .sort((a, b) => a.start.localeCompare(b.start))[0];
    if (upcoming) {
      bb.hidden = false;
      bb.textContent = `${upcoming.name || "Break"} starts in ${daysBetween(info.today, upcoming.start)} days`;
    } else bb.hidden = true;
  }

  const active = state.assignments.filter(a => a.status !== "done");
  const overdue = active.filter(a => bucketOf(a) === "old").length;
  $("#homeStats").innerHTML = `
    <div class="stat"><div class="v">${active.length}</div><div class="l">Active</div></div>
    <div class="stat"><div class="v">${overdue}</div><div class="l">Overdue</div></div>
    <div class="stat"><div class="v">${state.assignments.filter(a => a.status === "done").length}</div><div class="l">Done</div></div>
  `;

  const buckets = { new: [], upcoming: [], urgent: [], old: [] };
  active.forEach(a => buckets[bucketOf(a)].push(a));
  Object.values(buckets).forEach(list =>
    list.sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"))
  );

  for (const key of Object.keys(buckets)) {
    const el = $("#bucket-" + key);
    const list = buckets[key];
    $("#count-" + key).textContent = list.length;
    el.innerHTML = list.length
      ? list.map(taskRowHTML).join("")
      : `<div class="bucket-empty">Nothing here.</div>`;
  }

  $$("#view-home .task input[type=checkbox]").forEach(cb => {
    cb.onchange = () => toggleDone(cb.dataset.id, cb.checked);
  });
}

function taskRowHTML(a) {
  const b = bucketOf(a);
  const today = todayISO();
  let dueCls = "", dueTxt = "No due date";
  if (a.due) {
    dueTxt = shortDate(a.due);
    if (a.due < today) { dueCls = "overdue"; dueTxt = "Overdue · " + dueTxt; }
    else if (b === "urgent") { dueCls = "due-soon"; }
  }
  return `
    <div class="task" data-id="${a.id}">
      <input type="checkbox" data-id="${a.id}" ${a.status === "done" ? "checked" : ""}>
      <div class="task-body">
        <div class="task-title">${escapeHTML(a.title)}</div>
        <div class="task-meta">
          ${a.subject ? `<span class="chip">${escapeHTML(a.subject)}</span>` : ""}
          <span class="chip ${dueCls}">${escapeHTML(dueTxt)}</span>
          ${a.estimatedMinutes ? `<span>${a.estimatedMinutes} min</span>` : ""}
        </div>
      </div>
    </div>`;
}

function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function toggleDone(id, done) {
  const payload = done
    ? { status: "done", completedAt: serverTimestamp() }
    : { status: "active", completedAt: null };
  await updateDoc(doc(db, "users", state.user.uid, "assignments", id), payload);
}

/* ═══════════════════ RENDER: ASSIGNMENTS ═══════════════════ */
function renderAssignments() {
  const active = state.assignments.filter(a => a.status !== "done")
    .sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
  const done = state.assignments.filter(a => a.status === "done")
    .sort((a, b) => (b.completedAt?.toMillis?.() || 0) - (a.completedAt?.toMillis?.() || 0));

  $("#assignActive").innerHTML = active.length
    ? active.map(assignRowHTML).join("")
    : `<div class="bucket-empty">No active assignments.</div>`;

  $("#assignDone").innerHTML = done.length
    ? done.map(assignRowHTML).join("")
    : `<div class="bucket-empty">Nothing completed yet.</div>`;

  $$("#view-assignments .task input[type=checkbox]").forEach(cb => {
    cb.onchange = () => toggleDone(cb.dataset.id, cb.checked);
  });
  $$("#view-assignments .js-sched").forEach(btn => {
    btn.onclick = () => toggleScheduleForm(btn.closest(".task"), btn.dataset.id);
  });
  $$("#view-assignments .js-del").forEach(btn => {
    btn.onclick = async () => {
      if (!confirm("Delete this assignment?")) return;
      await deleteDoc(doc(db, "users", state.user.uid, "assignments", btn.dataset.id));
    };
  });
}

function assignRowHTML(a) {
  const b = bucketOf(a);
  const today = todayISO();
  let dueTxt = a.due ? shortDate(a.due) : "No due date";
  let dueCls = "";
  if (a.due && a.due < today) { dueCls = "overdue"; dueTxt = "Overdue · " + dueTxt; }
  else if (b === "urgent") dueCls = "due-soon";

  return `
    <div class="task ${a.status === "done" ? "done" : ""}" data-id="${a.id}">
      <input type="checkbox" data-id="${a.id}" ${a.status === "done" ? "checked" : ""}>
      <div class="task-body">
        <div class="task-title">${escapeHTML(a.title)}</div>
        <div class="task-meta">
          ${a.subject ? `<span class="chip">${escapeHTML(a.subject)}</span>` : ""}
          <span class="chip ${dueCls}">${escapeHTML(dueTxt)}</span>
          ${a.estimatedMinutes ? `<span>${a.estimatedMinutes} min</span>` : ""}
          ${a.notes ? `<span title="${escapeHTML(a.notes)}">· note</span>` : ""}
        </div>
      </div>
      <button class="icon-btn js-sched" data-id="${a.id}" title="Schedule into time-boxing">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>
      </button>
      <button class="icon-btn js-del" data-id="${a.id}" title="Delete">
        <svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
      </button>
    </div>`;
}

function toggleScheduleForm(row, id) {
  const existing = row.nextElementSibling;
  if (existing && existing.classList.contains("sched-form")) { existing.remove(); return; }

  const a = state.assignments.find(x => x.id === id);
  const html = `
    <div class="sched-form">
      <label class="small muted">Date</label>
      <input type="date" class="sf-date" value="${a?.due && a.due >= todayISO() ? a.due : state.tbDate}">
      <label class="small muted">Hour</label>
      <select class="sf-hour">
        ${Array.from({ length: 18 }, (_, i) => i + 6)
          .map(h => `<option value="${h}">${String(h).padStart(2, "0")}:00</option>`).join("")}
      </select>
      <button class="btn primary sf-save">Add to timeline</button>
    </div>`;
  row.insertAdjacentHTML("afterend", html);

  const form = row.nextElementSibling;
  form.querySelector(".sf-save").onclick = async () => {
    const date = form.querySelector(".sf-date").value;
    const hour = Number(form.querySelector(".sf-hour").value);
    if (!date) return toast("Pick a date");
    await addDoc(collection(db, "users", state.user.uid, "timebox"), {
      date, hour,
      title: a.title,
      subject: a.subject || "",
      assignmentId: a.id,
      createdAt: serverTimestamp()
    });
    form.remove();
    toast("Added to timeline");
  };
}

$("#btnToggleAdd").onclick = () => { $("#manualForm").hidden = !$("#manualForm").hidden; };
$("#btnCancelAdd").onclick  = () => { $("#manualForm").hidden = true; };

$("#btnSaveManual").onclick = async () => {
  const title = $("#mTitle").value.trim();
  if (!title) return toast("Title is required");
  await addDoc(collection(db, "users", state.user.uid, "assignments"), {
    title,
    subject: $("#mSubject").value.trim(),
    due: $("#mDue").value || "",
    estimatedMinutes: Number($("#mMins").value) || 0,
    notes: $("#mNotes").value.trim(),
    status: "active",
    source: "manual",
    createdAt: serverTimestamp()
  });
  $("#mTitle").value = $("#mSubject").value = $("#mDue").value = $("#mMins").value = $("#mNotes").value = "";
  $("#manualForm").hidden = true;
  toast("Assignment added");
};

/* ═══════════════════ RENDER: TIMEBOX ═══════════════════ */
const HOURS = Array.from({ length: 18 }, (_, i) => i + 6); // 06:00 – 23:00

function renderTimebox() {
  $("#tbDate").value = state.tbDate;
  $("#tbSubtitle").textContent = prettyDate(state.tbDate);

  const items = state.timebox.filter(t => t.date === state.tbDate);
  const grid = $("#tbGrid");

  grid.innerHTML = HOURS.map(h => {
    const slots = items.filter(t => Number(t.hour) === h);
    return `
      <div class="tb-row">
        <div class="tb-hour">${String(h).padStart(2, "0")}:00</div>
        <div class="tb-slot" data-hour="${h}">
          ${slots.map(s => `
            <div class="tb-chip" data-tid="${s.id}">
              <span>${escapeHTML(s.title)}${s.subject ? `<span class="sub">${escapeHTML(s.subject)}</span>` : ""}</span>
              <button class="tb-del" data-tid="${s.id}" title="Remove">&times;</button>
            </div>`).join("")}
        </div>
      </div>`;
  }).join("");

  $$("#tbGrid .tb-slot").forEach(slot => {
    slot.onclick = (e) => {
      if (e.target.closest(".tb-chip")) return;
      openQuickAdd(slot);
    };
  });
  $$("#tbGrid .tb-del").forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      await deleteDoc(doc(db, "users", state.user.uid, "timebox", btn.dataset.tid));
    };
  });
}

function openQuickAdd(slot) {
  if (slot.querySelector(".tb-add")) return;
  const hour = Number(slot.dataset.hour);
  slot.insertAdjacentHTML("beforeend",
    `<div class="tb-add">
       <input type="text" placeholder="Task title…" autofocus>
     </div>`);
  const input = slot.querySelector(".tb-add input");
  input.focus();
  const commit = async () => {
    const title = input.value.trim();
    if (!title) { slot.querySelector(".tb-add")?.remove(); return; }
    await addDoc(collection(db, "users", state.user.uid, "timebox"), {
      date: state.tbDate, hour, title, subject: "", assignmentId: null,
      createdAt: serverTimestamp()
    });
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") slot.querySelector(".tb-add")?.remove();
  };
  input.onblur = () => setTimeout(() => { if (input.value.trim()) commit(); else slot.querySelector(".tb-add")?.remove(); }, 120);
}

$("#tbDate").onchange = (e) => { state.tbDate = e.target.value; renderTimebox(); };
$("#tbPrev").onclick  = () => { state.tbDate = shiftISO(state.tbDate, -1); renderTimebox(); };
$("#tbNext").onclick  = () => { state.tbDate = shiftISO(state.tbDate,  1); renderTimebox(); };
$("#tbToday").onclick = () => { state.tbDate = todayISO(); renderTimebox(); };

/* ═══════════════════ RENDER: SETTINGS ═══════════════════ */
function renderSettings() {
  const p = state.profile;
  $("#setApiKey").value    = p.apiKey || "";
  $("#setModel").value     = p.model || CONFIG.defaultModel;
  $("#setTermStart").value = p.termStart || "";
  $("#setSchoolDays").value = p.schoolDays || 5;
  $("#setNavPos").value    = p.navPosition || "top";
  renderBreaks();
}

function renderBreaks() {
  const list = state.profile.breaks || [];
  $("#breakList").innerHTML = list.map((b, i) => `
    <div class="break-row" data-i="${i}">
      <input class="bk-name"  type="text" placeholder="Christmas break" value="${escapeHTML(b.name || "")}">
      <input class="bk-start" type="date" value="${b.start || ""}">
      <input class="bk-end"   type="date" value="${b.end || ""}">
      <button class="icon-btn bk-del" data-i="${i}" title="Remove">
        <svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
      </button>
    </div>`).join("") || `<p class="muted small" style="margin-bottom:12px">No breaks configured.</p>`;

  $$("#breakList .bk-del").forEach(b => {
    b.onclick = () => {
      const next = [...(state.profile.breaks || [])];
      next.splice(Number(b.dataset.i), 1);
      state.profile.breaks = next;
      renderBreaks();
    };
  });
  $$("#breakList .break-row input").forEach(inp => {
    inp.oninput = () => {
      const i = Number(inp.closest(".break-row").dataset.i);
      const next = [...(state.profile.breaks || [])];
      if (!next[i]) return;
      next[i] = {
        name:  inp.closest(".break-row").querySelector(".bk-name").value,
        start: inp.closest(".break-row").querySelector(".bk-start").value,
        end:   inp.closest(".break-row").querySelector(".bk-end").value
      };
      state.profile.breaks = next;
    };
  });
}

$("#btnAddBreak").onclick = () => {
  state.profile.breaks = [...(state.profile.breaks || []), { name: "", start: "", end: "" }];
  renderBreaks();
};

$("#btnSaveSettings").onclick = async () => {
  const apiKey = $("#setApiKey").value.trim();
  await setDoc(doc(db, "users", state.user.uid), {
    apiKey,
    model: $("#setModel").value,
    termStart: $("#setTermStart").value || "",
    schoolDays: Number($("#setSchoolDays").value) || 5,
    navPosition: $("#setNavPos").value,
    breaks: (state.profile.breaks || []).filter(b => b.name || b.start || b.end)
  }, { merge: true });
  toast("Settings saved");
  renderHome();
};

$("#btnTestKey").onclick = async () => {
  const st = $("#keyStatus");
  st.textContent = "Testing…"; st.className = "status";
  try {
    await callGemini("Reply with exactly: OK", { apiKey: $("#setApiKey").value.trim(), model: $("#setModel").value, json: false });
    st.textContent = "Connection works."; st.className = "status ok";
  } catch (e) {
    st.textContent = e.message; st.className = "status err";
  }
};

/* ═══════════════════ AI: GEMINI ═══════════════════ */
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    assignments: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          title:            { type: "STRING" },
          subject:          { type: "STRING" },
          due:              { type: "STRING", description: "YYYY-MM-DD local date, or empty string if unknown" },
          estimatedMinutes: { type: "INTEGER" },
          notes:            { type: "STRING" },
          schedule: {
            type: "OBJECT",
            properties: {
              date: { type: "STRING", description: "YYYY-MM-DD" },
              hour: { type: "INTEGER", description: "0-23" }
            }
          }
        },
        required: ["title"]
      }
    }
  },
  required: ["assignments"]
};

async function callGemini(prompt, { apiKey, model, json = true, systemText = "" } = {}) {
  if (!apiKey) throw new Error("No API key set — open Settings.");
  if (!navigator.onLine) throw new Error("AI temporarily unavailable offline.");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2 }
  };
  if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };
  if (json) {
    body.generationConfig.responseMimeType = "application/json";
    body.generationConfig.responseSchema = RESPONSE_SCHEMA;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${txt.slice(0, 160)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Empty AI response.");
  return json ? JSON.parse(text) : text;
}

function buildSystemPrompt() {
  const info = academicNow();
  const p = state.profile;
  const breaks = (p.breaks || []).filter(b => b.start);
  const breakLines = breaks.length
    ? breaks.map(b => `  • ${b.name || "Break"}: ${b.start} → ${b.end}`).join("\n")
    : "  (none configured)";

  const dow = new Date().toLocaleDateString(undefined, { weekday: "long" });
  const perWeek = Math.max(1, Number(p.schoolDays) || 5);
  const termStart = p.termStart || "(not set)";

  return `You are an assignment parser for a school planner.

CURRENT CONTEXT (authoritative — never contradict these):
  Today's date: ${info.today} (${dow})
  Local time: ${new Date().toLocaleTimeString()}
  Academic position: ${info.week ? `Week ${info.week}, Day ${info.day}` : "outside term"}
  Term started: ${termStart} — this date is Week 1 Day 1
  School week structure: ${perWeek} school days per week, Monday through Friday only. Weekends are skipped entirely.
${info.breakName ? `  CURRENTLY ON BREAK: ${info.breakName}` : ""}

KNOWN BREAKS (school days that fall inside these ranges do NOT advance the week/day tally):
${breakLines}

HOW TO RESOLVE "WEEK N DAY M" REFERENCES IN THE USER'S TEXT:
  Walk forward in calendar days from ${termStart}, counting only school days
  (Mon–Fri, skipping weekends and any date inside a listed break).
  The 1st school day is Week 1 Day 1. The ${perWeek + 1}th school day is Week 2 Day 1.
  Convert every "week N day M" phrase the text mentions into the correct YYYY-MM-DD date
  and put that date in "due". If a task has no explicit date and no week/day reference,
  leave "due" as an empty string — do not guess.

RULES:
1. Extract every distinct assignment or task from the user's text.
2. Resolve all relative dates ("tomorrow", "next Friday", "after half term", "week 3 day 2")
   against the context above. Always output YYYY-MM-DD.
3. If a date is ambiguous or absent, output an empty string for "due". NEVER invent a date.
4. "subject" should be the class name only (e.g. "Chemistry"), not a description.
5. "estimatedMinutes" is your best estimate of working time; use 0 if truly unknown.
6. If the text says when the student plans to work on something, fill in "schedule".
7. Titles should be short and actionable.`;
}

$("#btnParse").onclick = async () => {
  const text = $("#portalInput").value.trim();
  const st = $("#parseStatus");
  if (!text) { st.textContent = "Paste some text first."; st.className = "status err"; return; }

  const apiKey = state.profile.apiKey;
  const model  = state.profile.model || CONFIG.defaultModel;

  $("#btnParse").disabled = true;
  st.textContent = "Thinking…"; st.className = "status";

  try {
    const out = await callGemini(text, { apiKey, model, systemText: buildSystemPrompt() });
    state.parsed = (out.assignments || []).map(a => ({
      title: a.title || "",
      subject: a.subject || "",
      due: a.due || "",
      estimatedMinutes: Number(a.estimatedMinutes) || 0,
      notes: a.notes || "",
      schedule: a.schedule || null,
      include: true
    }));
    renderPreview();
    st.textContent = `Found ${state.parsed.length} item${state.parsed.length === 1 ? "" : "s"}.`;
    st.className = "status ok";
  } catch (e) {
    st.textContent = e.message;
    st.className = "status err";
  } finally {
    $("#btnParse").disabled = false;
  }
};

$("#btnClearPortal").onclick = () => {
  $("#portalInput").value = "";
  state.parsed = [];
  $("#previewWrap").hidden = true;
  $("#parseStatus").textContent = "";
};

$("#btnDiscardParsed").onclick = () => {
  state.parsed = [];
  $("#previewWrap").hidden = true;
};

function renderPreview() {
  const wrap = $("#previewWrap");
  if (!state.parsed.length) { wrap.hidden = true; return; }
  wrap.hidden = false;

  $("#previewList").innerHTML = state.parsed.map((p, i) => `
    <div class="preview-item" data-i="${i}">
      <input class="pv-title"   value="${escapeHTML(p.title)}"   placeholder="Title">
      <input class="pv-subject" value="${escapeHTML(p.subject)}" placeholder="Subject">
      <input class="pv-due"     type="date" value="${p.due || ""}">
      <input class="pv-mins"    type="number" min="0" step="5" value="${p.estimatedMinutes || ""}" placeholder="min">
      <button class="icon-btn pv-del" data-i="${i}" title="Remove">
        <svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
      </button>
    </div>`).join("");

  $$("#previewList .preview-item input").forEach(inp => {
    inp.oninput = () => {
      const i = Number(inp.closest(".preview-item").dataset.i);
      const row = inp.closest(".preview-item");
      state.parsed[i].title = row.querySelector(".pv-title").value;
      state.parsed[i].subject = row.querySelector(".pv-subject").value;
      state.parsed[i].due = row.querySelector(".pv-due").value;
      state.parsed[i].estimatedMinutes = Number(row.querySelector(".pv-mins").value) || 0;
    };
  });
  $$("#previewList .pv-del").forEach(b => {
    b.onclick = () => { state.parsed.splice(Number(b.dataset.i), 1); renderPreview(); };
  });
}

$("#btnSaveParsed").onclick = async () => {
  if (!state.parsed.length) return;
  const batch = writeBatch(db);
  const uid = state.user.uid;

  for (const p of state.parsed) {
    if (!p.title.trim()) continue;
    const ref = doc(collection(db, "users", uid, "assignments"));
    batch.set(ref, {
      title: p.title.trim(),
      subject: p.subject.trim(),
      due: p.due || "",
      estimatedMinutes: p.estimatedMinutes || 0,
      notes: p.notes || "",
      status: "active",
      source: "ai",
      createdAt: serverTimestamp()
    });
    if (p.schedule && p.schedule.date && Number.isInteger(p.schedule.hour)) {
      const tref = doc(collection(db, "users", uid, "timebox"));
      batch.set(tref, {
        date: p.schedule.date,
        hour: p.schedule.hour,
        title: p.title.trim(),
        subject: p.subject.trim(),
        assignmentId: ref.id,
        createdAt: serverTimestamp()
      });
    }
  }
  await batch.commit();
  state.parsed = [];
  $("#previewWrap").hidden = true;
  $("#portalInput").value = "";
  $("#parseStatus").textContent = "Saved.";
  $("#parseStatus").className = "status ok";
  toast("Assignments saved");
  switchView("home");
};

/* ═══════════════════ SERVICE WORKER ═══════════════════ */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

window.addEventListener("online",  () => toast("Back online"));
window.addEventListener("offline", () => toast("Offline — changes will sync later"));

/* ═══════════════════ BOOT ═══════════════════ */
switchView("home");
renderTimebox();
