import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import {
  getFirestore, doc, collection, getDoc, setDoc, deleteDoc, onSnapshot, runTransaction, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

/* ==========================================================================
   FIREBASE: autenticazione e sincronizzazione

   Struttura dei dati su Firestore:
     users/{uid}                      -> documento storico (vecchia struttura): l'app lo legge
                                         UNA SOLA VOLTA per la migrazione e poi non lo modifica più,
                                         quindi resta intatto come backup.
     users/{uid}/settings/app         -> { activePropertyId, migratedAt, migratedFrom }
     users/{uid}/properties/{propId}  -> { name, tenants, expenses, payments, updatedAt }
                                         (un documento per ogni appartamento)
   ========================================================================== */

const firebaseConfig = {
  apiKey: "AIzaSyBuyOBhjDdxHi92mETmrrAKx69Rf78tInc",
  authDomain: "pagamenti-kennedy-51.firebaseapp.com",
  projectId: "pagamenti-kennedy-51",
  storageBucket: "pagamenti-kennedy-51.firebasestorage.app",
  messagingSenderId: "990570367263",
  appId: "1:990570367263:web:4fe06666780660a10a482a"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

let currentUser = null;
let unsubscribe = null;
let creatingDefaultProperty = false;

let rootData = {
  activePropertyId: null,
  properties: {}
};

let state = { tenants: [], expenses: [], payments: [] };

const legacyRef = uid => doc(db, "users", uid);
const settingsRef = uid => doc(db, "users", uid, "settings", "app");
const propertiesCol = uid => collection(db, "users", uid, "properties");
const propertyRef = (uid, id) => doc(db, "users", uid, "properties", id);

/* ---------- Funzioni pure (dati) ---------- */

function normalizeProperty(p) {
  const src = p && typeof p === "object" ? p : {};
  return {
    name: typeof src.name === "string" ? src.name : "",
    tenants: Array.isArray(src.tenants) ? src.tenants : [],
    expenses: (Array.isArray(src.expenses) ? src.expenses : []).map(e => ({
      ...e,
      tenantIds: Array.isArray(e && e.tenantIds) ? e.tenantIds : []
    })),
    payments: Array.isArray(src.payments) ? src.payments : []
  };
}

// Documento da scrivere su Firestore (solo i campi ammessi dalle regole; niente valori undefined)
function toPropertyPayload(p) {
  const clean = normalizeProperty(p);
  return JSON.parse(JSON.stringify({
    name: clean.name || "Appartamento",
    tenants: clean.tenants,
    expenses: clean.expenses,
    payments: clean.payments,
    updatedAt: Date.now()
  }));
}

// Trasforma il vecchio documento unico negli appartamenti separati (non scrive nulla)
function buildMigrationPlan(legacyData, now = Date.now()) {
  const properties = {};
  let activeId = null;

  if (legacyData && legacyData.properties && typeof legacyData.properties === "object"
      && Object.keys(legacyData.properties).length) {
    Object.entries(legacyData.properties).forEach(([id, p]) => { properties[id] = normalizeProperty(p); });
    activeId = properties[legacyData.activePropertyId] ? legacyData.activePropertyId : Object.keys(properties)[0];
  } else if (legacyData && (legacyData.tenants || legacyData.expenses || legacyData.payments)) {
    // Formato ancora più vecchio: un solo appartamento con i dati in radice
    const id = "prop_" + now;
    properties[id] = normalizeProperty({
      name: "Appartamento 1",
      tenants: legacyData.tenants,
      expenses: legacyData.expenses,
      payments: legacyData.payments
    });
    activeId = id;
  } else {
    const id = "prop_" + now;
    properties[id] = normalizeProperty({ name: "Appartamento 1" });
    activeId = id;
  }
  return { properties, activeId };
}

/* ---------- Stato locale ---------- */

function loadActivePropertyState() {
  if (rootData.activePropertyId && rootData.properties[rootData.activePropertyId]) {
    state = rootData.properties[rootData.activePropertyId];
  } else {
    state = { tenants: [], expenses: [], payments: [] };
  }
}

function updatePropertyDropdown() {
  const select = document.getElementById("propertySelect");
  const activeNameLabel = document.getElementById("activePropertyName");
  if (!select || !activeNameLabel) return;

  select.innerHTML = "";
  const keys = Object.keys(rootData.properties || {});

  keys.forEach((id, index) => {
    const prop = rootData.properties[id];
    let displayName = prop.name;
    if (!displayName || displayName.trim() === "" || displayName.includes("prop_")) {
      displayName = `Appartamento ${index + 1}`;
      prop.name = displayName;
    }

    const option = document.createElement("option");
    option.value = id;
    option.textContent = displayName;

    if (id === rootData.activePropertyId) {
      option.selected = true;
      activeNameLabel.textContent = displayName;
    }
    select.appendChild(option);
  });
}

/* ---------- Stato di sincronizzazione ---------- */

function setStatusOk() {
  const syncStatus = document.getElementById("syncStatus");
  if (currentUser && syncStatus) syncStatus.textContent = `🟢 Utente: ${currentUser.displayName || currentUser.email}`;
}

function setStatusError(error, fallback) {
  console.error(fallback, error);
  const syncStatus = document.getElementById("syncStatus");
  if (!syncStatus) return;
  syncStatus.textContent = error && error.code === "permission-denied"
    ? "🔴 Permessi Firestore insufficienti: aggiorna le regole"
    : fallback;
}

function ensureLogin() {
  if (currentUser) return true;
  alert("Devi accedere con Google per salvare i tuoi dati!");
  window.login();
  return false;
}

// Esegue una scrittura mostrando lo stato "Salvataggio..." / errore
async function withSync(task) {
  const syncStatus = document.getElementById("syncStatus");
  if (syncStatus) syncStatus.textContent = "⏳ Salvataggio...";
  try {
    await task();
    setStatusOk();
  } catch (e) {
    setStatusError(e, "🔴 Errore Salvataggio");
  }
}

/* ---------- Scritture su Firestore ---------- */

// Salva SOLO l'appartamento attivo (documento piccolo, non l'intero archivio)
async function saveCloud() {
  if (!ensureLogin()) return;
  const id = rootData.activePropertyId;
  const prop = rootData.properties[id];
  if (!id || !prop) return;
  await withSync(() => setDoc(propertyRef(currentUser.uid, id), toPropertyPayload(prop)));
}

function saveSettings() {
  return setDoc(settingsRef(currentUser.uid), { activePropertyId: rootData.activePropertyId }, { merge: true });
}

async function createProperty(name) {
  const id = "prop_" + Date.now();
  rootData.properties[id] = normalizeProperty({ name });
  rootData.activePropertyId = id;
  loadActivePropertyState();
  updatePropertyDropdown();
  renderAll();
  await withSync(async () => {
    await setDoc(propertyRef(currentUser.uid, id), toPropertyPayload(rootData.properties[id]));
    await saveSettings();
  });
}

// Migrazione una tantum: copia il vecchio documento negli appartamenti separati.
// Il vecchio documento viene solo letto. Transazione: o scrive tutto o niente.
async function ensureMigrated(uid) {
  await runTransaction(db, async tx => {
    const settingsSnap = await tx.get(settingsRef(uid));
    if (settingsSnap.exists()) return;

    const legacySnap = await tx.get(legacyRef(uid));
    const plan = buildMigrationPlan(legacySnap.exists() ? legacySnap.data() : null);

    Object.entries(plan.properties).forEach(([id, p]) => {
      tx.set(propertyRef(uid, id), toPropertyPayload(p));
    });
    tx.set(settingsRef(uid), {
      activePropertyId: plan.activeId,
      migratedAt: serverTimestamp(),
      migratedFrom: legacySnap.exists() ? `users/${uid}` : null
    });
  });
}

/* ---------- Sincronizzazione in tempo reale ---------- */

async function startSync(user) {
  try {
    await ensureMigrated(user.uid);
    const settingsSnap = await getDoc(settingsRef(user.uid));
    rootData.activePropertyId = settingsSnap.exists() ? settingsSnap.data().activePropertyId : null;
  } catch (error) {
    setStatusError(error, "🔴 Errore caricamento dati");
    return;
  }

  if (!currentUser || currentUser.uid !== user.uid) return; // logout durante il caricamento

  if (unsubscribe) unsubscribe();
  unsubscribe = onSnapshot(propertiesCol(user.uid), snap => {
    const props = {};
    snap.forEach(d => { props[d.id] = normalizeProperty(d.data()); });
    rootData.properties = props;

    const ids = Object.keys(props);
    if (!ids.length) {
      // Nessun appartamento sul server (es. cancellati dalla console): ne crea uno vuoto
      if (!snap.metadata.fromCache && !creatingDefaultProperty) {
        creatingDefaultProperty = true;
        createProperty("Appartamento 1").finally(() => { creatingDefaultProperty = false; });
      }
      return;
    }

    if (!props[rootData.activePropertyId]) {
      rootData.activePropertyId = ids[0];
      saveSettings().catch(e => console.error("Errore salvataggio impostazioni:", e));
    }

    loadActivePropertyState();
    updatePropertyDropdown();
    setStatusOk();
    renderAll();
  }, error => setStatusError(error, "🔴 Errore caricamento dati"));
}

onAuthStateChanged(auth, (user) => {
  const syncStatus = document.getElementById("syncStatus");
  const loginBtn = document.getElementById("loginBtn");
  const logoutBtn = document.getElementById("logoutBtn");

  if (user) {
    currentUser = user;
    syncStatus.textContent = `🟢 Utente: ${user.displayName || user.email}`;
    loginBtn.style.display = "none";
    logoutBtn.style.display = "inline-block";
    startSync(user);
  } else {
    currentUser = null;
    rootData = { activePropertyId: null, properties: {} };
    state = { tenants: [], expenses: [], payments: [] };
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    syncStatus.textContent = "🔒 Accedi per salvare i dati";
    loginBtn.style.display = "inline-block";
    logoutBtn.style.display = "none";
    updatePropertyDropdown();
    renderAll();
  }
});

/* ---------- Azioni richiamate dall'interfaccia ---------- */

window.createNewProperty = async () => {
  if (!ensureLogin()) return;
  const name = prompt("Inserisci il nome del nuovo appartamento (es. 'Via Roma 10'):");
  if (name === null) return;
  await createProperty(name.trim() ? name.trim() : "Appartamento");
};

window.renameCurrentProperty = async () => {
  const id = rootData.activePropertyId;
  if (!id || !rootData.properties[id]) return;
  if (!ensureLogin()) return;
  const currentName = rootData.properties[id].name || "Appartamento";
  const newName = prompt("Inserisci il nuovo nome dell'appartamento:", currentName);

  if (newName !== null && newName.trim() !== "") {
    rootData.properties[id].name = newName.trim();
    updatePropertyDropdown();
    await withSync(() => setDoc(propertyRef(currentUser.uid, id), { name: newName.trim(), updatedAt: Date.now() }, { merge: true }));
  }
};

window.switchProperty = async (propertyId) => {
  if (!rootData.properties[propertyId]) return;
  rootData.activePropertyId = propertyId;
  loadActivePropertyState();
  updatePropertyDropdown();
  renderAll();
  if (currentUser) await withSync(saveSettings); // salva solo la scelta, non i dati
};

window.deleteCurrentProperty = async () => {
  const keys = Object.keys(rootData.properties);
  if (keys.length <= 1) {
    alert("Devi avere almeno un appartamento gestito.");
    return;
  }
  if (!ensureLogin()) return;
  const id = rootData.activePropertyId;
  const currentPropName = rootData.properties[id]?.name || "questo appartamento";
  if (!confirm(`Sei sicuro di voler eliminare definitivamente "${currentPropName}" e tutti i suoi dati?`)) return;

  delete rootData.properties[id];
  rootData.activePropertyId = Object.keys(rootData.properties)[0];
  loadActivePropertyState();
  updatePropertyDropdown();
  renderAll();
  await withSync(async () => {
    await deleteDoc(propertyRef(currentUser.uid, id));
    await saveSettings();
  });
};

window.login = () => signInWithPopup(auth, provider).catch(err => alert("Errore login: " + err.message));
window.logout = () => signOut(auth);
window.save = saveCloud;
window.getState = () => state;

/* ==========================================================================
   LOGICA DELL'APPLICAZIONE
   ========================================================================== */

const money = value => new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(Number(value) || 0);
const escapeHtml = value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");

// Istanza Grafici Chart.js globali
let charts = {};

function formatDate(dateString) {
  if (!dateString) return "-";
  const parts = dateString.split("-");
  if (parts.length === 2) return formatMonth(dateString);
  const [year, month, day] = parts.map(Number);
  if (!year || !month || !day) return dateString;
  const date = new Date(year, month - 1, day);
  const dayStr = String(date.getDate()).padStart(2, "0");
  const monthName = date.toLocaleDateString("it-IT", { month: "long" });
  return `${dayStr} ${monthName.charAt(0).toUpperCase() + monthName.slice(1)} ${date.getFullYear()}`;
}

function formatMonth(monthString) {
  if (!monthString) return "-";
  const parts = monthString.split("-");
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  if (!year || !month) return monthString;
  const date = new Date(year, month - 1, 1);
  const monthName = date.toLocaleDateString("it-IT", { month: "long" });
  const capMonth = monthName.charAt(0).toUpperCase() + monthName.slice(1);
  if (parts.length === 3) return `${String(Number(parts[2])).padStart(2, "0")} ${capMonth} ${year}`;
  return `${capMonth} ${year}`;
}

function monthToIndex(value) {
  if (!value) return 0;
  const parts = value.split("-").map(Number);
  return parts[0] * 12 + parts[1] - 1;
}

function getCurrentMonthIndex() {
  const now = new Date();
  return now.getFullYear() * 12 + now.getMonth();
}

function getRentMonths(tenant, yearFilter = "ALL") {
  if (!tenant.contractStart || !tenant.contractEnd) return [];
  const start = monthToIndex(tenant.contractStart);
  const end = monthToIndex(tenant.contractEnd);
  const lastMonth = Math.min(end, getCurrentMonthIndex());
  const months = [];
  for (let index = start; index <= lastMonth; index++) {
    const year = Math.floor(index / 12);
    const month = (index % 12) + 1;
    const monthStr = `${year}-${String(month).padStart(2, "0")}`;
    if (yearFilter === "ALL" || String(year) === String(yearFilter)) {
      months.push(monthStr);
    }
  }
  return months;
}

function getAvailableYears() {
  const state = window.getState ? window.getState() : { expenses: [], payments: [] };
  const yearsSet = new Set();
  
  (state.expenses || []).forEach(e => { if (e.date) yearsSet.add(e.date.split("-")[0]); });
  (state.payments || []).forEach(p => { if (p.date) yearsSet.add(p.date.split("-")[0]); });
  (state.tenants || []).forEach(t => {
    if (t.contractStart) yearsSet.add(t.contractStart.split("-")[0]);
    if (t.contractEnd) yearsSet.add(t.contractEnd.split("-")[0]);
  });

  yearsSet.add(String(new Date().getFullYear()));
  return Array.from(yearsSet).sort((a, b) => b.localeCompare(a));
}

function updateYearDropdowns() {
  const years = getAvailableYears();
  const expSelect = document.getElementById("yearFilterExpenses");
  const rmSelect = document.getElementById("yearFilterRooms");
  const dashSelect = document.getElementById("yearFilterDashboard");

  [expSelect, rmSelect, dashSelect].forEach(select => {
    if (!select) return;
    const currentVal = select.value;
    select.innerHTML = '<option value="ALL">Da sempre (Tutti gli anni)</option>';
    years.forEach(y => {
      const opt = document.createElement("option");
      opt.value = y;
      opt.textContent = y;
      select.appendChild(opt);
    });
    if (currentVal && Array.from(select.options).some(o => o.value === currentVal)) {
      select.value = currentVal;
    }
  });
}

function getTenantExpenses(tenantId, yearFilter = "ALL") {
  const state = window.getState ? window.getState() : { expenses: [] };
  return state.expenses
    .filter(expense => {
      const matchesTenant = expense.tenantIds.includes(tenantId);
      const matchesYear = yearFilter === "ALL" || (expense.date && expense.date.startsWith(yearFilter));
      return matchesTenant && matchesYear;
    })
    .map(expense => ({ ...expense, share: expense.amount / expense.tenantIds.length }));
}

function getTenantPayments(tenantId, yearFilter = "ALL") {
  const state = window.getState ? window.getState() : { payments: [] };
  return state.payments.filter(payment => {
    const matchesTenant = payment.tenantId === tenantId;
    const matchesYear = yearFilter === "ALL" || (payment.date && payment.date.startsWith(yearFilter));
    return matchesTenant && matchesYear;
  });
}

function getTenantSummary(tenant, yearFilter = "ALL") {
  const expenses = getTenantExpenses(tenant.id, yearFilter);
  const payments = getTenantPayments(tenant.id, yearFilter);
  const rentMonths = getRentMonths(tenant, yearFilter);
  const totalExpenses = expenses.reduce((sum, item) => sum + item.share, 0);
  const totalRent = rentMonths.length * Number(tenant.monthlyRent || 0);
  const totalPaid = payments.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const totalDue = totalExpenses + totalRent;
  return { expenses, payments, rentMonths, totalExpenses, totalRent, totalPaid, totalDue, balance: totalDue - totalPaid };
}

// Stato aperto/chiuso delle schede generate dinamicamente: sopravvive ai nuovi render
const sectionState = new Map();
const isSectionOpen = (id, defaultOpen = false) => sectionState.has(id) ? sectionState.get(id) : defaultOpen;
const openClass = (id, defaultOpen = false) => isSectionOpen(id, defaultOpen) ? " open" : "";
const arrowChar = (id, defaultOpen = false) => isSectionOpen(id, defaultOpen) ? "▲" : "▼";
const safeKey = value => String(value ?? "").replace(/[^A-Za-z0-9_-]/g, "_");

function toggleSection(contentId, arrowId) {
  const content = document.getElementById(contentId);
  const arrow = document.getElementById(arrowId);
  if (!content) return;

  const nowOpen = !content.classList.contains("open");
  content.classList.toggle("open", nowOpen);
  if (arrow) arrow.textContent = nowOpen ? "▲" : "▼";
  sectionState.set(contentId, nowOpen);
}

// --- Stato degli inquilini in base al contratto (calcolato per mese, come gli affitti maturati) ---
function pad2(n) { return String(n).padStart(2, "0"); }

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function getTenantStatus(tenant) {
  const current = getCurrentMonthIndex();
  if (tenant.contractStart && monthToIndex(tenant.contractStart) > current) return "upcoming";
  if (tenant.contractEnd && monthToIndex(tenant.contractEnd) < current) return "archived";
  return "active";
}

const TENANT_GROUPS = [
  { key: "active", title: "Inquilini attivi", empty: "Nessun inquilino con contratto attivo.", open: true },
  { key: "upcoming", title: "In attivazione", empty: "Nessun inquilino con contratto da iniziare.", open: false },
  { key: "archived", title: "Archivio", empty: "Nessun inquilino con contratto scaduto.", open: false }
];

function groupTenants(tenants) {
  const groups = { active: [], upcoming: [], archived: [] };
  (tenants || []).forEach(t => groups[getTenantStatus(t)].push(t));
  return groups;
}

// Costruisce i tre riquadri espandibili; renderBody(lista) genera il contenuto di ciascuno
function renderTenantGroups(pageKey, tenants, renderBody) {
  const groups = groupTenants(tenants);
  return TENANT_GROUPS.map(def => {
    const list = groups[def.key];
    const contentId = `group_${pageKey}_${def.key}`;
    const arrowId = `${contentId}_arrow`;
    return `
      <div class="card group-card">
        <div class="collapsible-header" onclick="toggleSection('${contentId}', '${arrowId}')">
          <h2>${def.title} (${list.length})</h2>
          <span id="${arrowId}" class="arrow-icon">${arrowChar(contentId, def.open)}</span>
        </div>
        <div id="${contentId}" class="collapsible-content${openClass(contentId, def.open)}">
          ${list.length ? renderBody(list) : `<p class="empty">${def.empty}</p>`}
        </div>
      </div>`;
  }).join("");
}

// Numero di inquilini con contratto attivo in ogni mese
// ("Da sempre": dal primo inizio contratto all'ultima fine; anno scelto: i 12 mesi dell'anno)
function computeTenantsMonthly(tenants, selectedYear, monthsLabels) {
  const withDates = (tenants || []).filter(t =>
    t.contractStart && t.contractEnd &&
    !isNaN(monthToIndex(t.contractStart)) && !isNaN(monthToIndex(t.contractEnd)));

  const indexes = [];
  if (selectedYear === "ALL") {
    if (withDates.length) {
      const first = Math.min(...withDates.map(t => monthToIndex(t.contractStart)));
      const last = Math.min(Math.max(...withDates.map(t => monthToIndex(t.contractEnd))), first + 599);
      for (let i = first; i <= last; i++) indexes.push(i);
    }
  } else {
    for (let m = 0; m < 12; m++) indexes.push(Number(selectedYear) * 12 + m);
  }

  const labels = indexes.map(i => selectedYear === "ALL"
    ? `${monthsLabels[i % 12]} ${Math.floor(i / 12)}`
    : monthsLabels[i % 12]);
  const data = indexes.map(i =>
    withDates.filter(t => i >= monthToIndex(t.contractStart) && i <= monthToIndex(t.contractEnd)).length);

  return { labels, data };
}

function toggleChartsToggle() {
  const collapsible = document.getElementById("chartsCollapsible");
  const icon = document.getElementById("chartsToggleIcon");
  if (collapsible.classList.contains("open")) {
    collapsible.classList.remove("open");
    icon.textContent = "▼";
  } else {
    collapsible.classList.add("open");
    icon.textContent = "▲";
    renderDashboardCharts();
  }
}

function renderAll() {
  updateYearDropdowns();
  renderDashboard();
  renderTenantChecks();
  renderTenants();
  renderExpenses();
  renderRooms();
}
window.renderAll = renderAll;

function renderDashboard() {
  const state = window.getState ? window.getState() : { tenants: [], expenses: [] };
  const selectedYear = document.getElementById("yearFilterDashboard")?.value || "ALL";
  const yearLabel = selectedYear === "ALL" ? "Da sempre" : selectedYear;

  document.getElementById("statTenants").textContent = state.tenants.filter(t => getTenantStatus(t) === "active").length;

  const filteredExpenses = (state.expenses || []).filter(e => selectedYear === "ALL" || (e.date && e.date.startsWith(selectedYear)));
  document.getElementById("statExpenses").textContent = filteredExpenses.length;
  document.getElementById("statExpenseAmount").textContent = money(filteredExpenses.reduce((sum, e) => sum + Number(e.amount || 0), 0));

  const totalDueOverall = state.tenants.reduce((sum, t) => {
    const summary = getTenantSummary(t, selectedYear);
    return sum + Math.max(summary.balance, 0);
  }, 0);

  document.getElementById("statDue").textContent = money(totalDueOverall);

  const container = document.getElementById("dashboardTenants");
  if (!state.tenants.length) {
    container.innerHTML = '<div class="card"><p class="empty">Nessun inquilino presente in questo appartamento.</p></div>';
  } else {
    container.innerHTML = renderTenantGroups("dashboard", state.tenants, list => `
      <div class="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Inquilino</th>
              <th>Stanza</th>
              <th>Totale dovuto (${yearLabel})</th>
              <th>Pagato (${yearLabel})</th>
              <th>Da pagare</th>
            </tr>
          </thead>
          <tbody>
            ${list.map(tenant => {
              const summary = getTenantSummary(tenant, selectedYear);
              const due = Math.max(summary.balance, 0);
              return `
                <tr>
                  <td>${escapeHtml(tenant.name)}</td>
                  <td>${escapeHtml(tenant.room || "-")}</td>
                  <td>${money(summary.totalDue)}</td>
                  <td>${money(summary.totalPaid)}</td>
                  <td class="${due > 0 ? "positive" : "negative"}">${money(due)}</td>
                </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>`);
  }

  // Aggiorna i grafici se la tendina è aperta
  if (document.getElementById("chartsCollapsible")?.classList.contains("open")) {
    renderDashboardCharts();
  }
}

// --- Render statistiche dashboard e grafici (utenze con spanGaps) ---
function renderDashboardCharts() {
  const state = window.getState ? window.getState() : { tenants: [], expenses: [], payments: [] };
  const selectedYear = document.getElementById("yearFilterDashboard")?.value || "ALL";

  // Mesi di etichetta
  const monthsLabels = ["Gen", "Feb", "Mar", "Apr", "Mag", "Giu", "Lug", "Ago", "Set", "Ott", "Nov", "Dic"];

  // 1. DATA: Inquilini con contratto attivo in ciascun mese
  const tenantsMonthly = computeTenantsMonthly(state.tenants, selectedYear, monthsLabels);

  // 2. DATA: Entrate vs Spese
  const incomeData = new Array(12).fill(0);
  const expenseData = new Array(12).fill(0);

  (state.payments || []).forEach(p => {
    if (!p.date) return;
    const [y, m] = p.date.split("-").map(Number);
    if (selectedYear === "ALL" || String(y) === String(selectedYear)) {
      if (m >= 1 && m <= 12) incomeData[m - 1] += Number(p.amount || 0);
    }
  });

  (state.expenses || []).forEach(e => {
    if (!e.date) return;
    const [y, m] = e.date.split("-").map(Number);
    if (selectedYear === "ALL" || String(y) === String(selectedYear)) {
      if (m >= 1 && m <= 12) expenseData[m - 1] += Number(e.amount || 0);
    }
  });

  // 3 & 4. DATA: Utenze per Categoria
  const catData = {
    Luce: new Array(12).fill(0),
    Gas: new Array(12).fill(0),
    Acqua: new Array(12).fill(0),
    Condominio: new Array(12).fill(0),
    Manutenzione: new Array(12).fill(0),
    Internet: new Array(12).fill(0)
  };

  (state.expenses || []).forEach(e => {
    if (!e.date || !e.category) return;
    const [y, m] = e.date.split("-").map(Number);
    if (selectedYear === "ALL" || String(y) === String(selectedYear)) {
      if (m >= 1 && m <= 12 && catData[e.category]) {
        catData[e.category][m - 1] += Number(e.amount || 0);
      }
    }
  });

  // Converte i valori 0 in null per non tracciare punti vuoti e collegare solo le spese reali
  const cleanUtilityData = (arr) => arr.map(v => v > 0 ? v : null);

  const luceClean = cleanUtilityData(catData.Luce);
  const gasClean = cleanUtilityData(catData.Gas);
  const acquaClean = cleanUtilityData(catData.Acqua);
  const condominioClean = cleanUtilityData(catData.Condominio);
  const manutenzioneClean = cleanUtilityData(catData.Manutenzione);
  const internetClean = cleanUtilityData(catData.Internet);

  // DISTRUZIONE GRAFICI PRECEDENTI (Reset)
  Object.keys(charts).forEach(key => { if (charts[key]) charts[key].destroy(); });

  // GRAFICO 1: INQUILINI
  charts.tenants = new Chart(document.getElementById("chartTenantsMonthly"), {
    type: "bar",
    data: {
      labels: tenantsMonthly.labels,
      datasets: [{ label: "Inquilini con contratto attivo", data: tenantsMonthly.data, backgroundColor: "#2563eb", borderRadius: 4 }]
    },
    options: { responsive: true, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } }
  });

  // GRAFICO 2: ENTRATE VS SPESE
  charts.incomeExpenses = new Chart(document.getElementById("chartIncomeExpenses"), {
    type: "bar",
    data: {
      labels: monthsLabels,
      datasets: [
        { label: "Entrate (Bonifici)", data: incomeData, backgroundColor: "#16a34a", borderRadius: 4 },
        { label: "Spese Totali", data: expenseData, backgroundColor: "#dc2626", borderRadius: 4 }
      ]
    },
    options: { responsive: true, scales: { y: { beginAtZero: true } } }
  });

  // GRAFICO 3: UTENZE PRIMARIE (LUCE, GAS, ACQUA)
  charts.utilitiesMain = new Chart(document.getElementById("chartUtilitiesMain"), {
    type: "line",
    data: {
      labels: monthsLabels,
      datasets: [
        { label: "Luce", data: luceClean, borderColor: "#eab308", backgroundColor: "#fef08a", spanGaps: true, tension: 0.2 },
        { label: "Gas", data: gasClean, borderColor: "#f97316", backgroundColor: "#ffedd5", spanGaps: true, tension: 0.2 },
        { label: "Acqua", data: acquaClean, borderColor: "#0284c7", backgroundColor: "#e0f2fe", spanGaps: true, tension: 0.2 }
      ]
    },
    options: {
      responsive: true,
      scales: { y: { beginAtZero: true } }
    }
  });

  // GRAFICO 4: ALTRE UTENZE (CONDOMINIO, MANUTENZIONE, INTERNET)
  charts.utilitiesOther = new Chart(document.getElementById("chartUtilitiesOther"), {
    type: "line",
    data: {
      labels: monthsLabels,
      datasets: [
        { label: "Condominio", data: condominioClean, borderColor: "#8b5cf6", backgroundColor: "#f3e8ff", spanGaps: true, tension: 0.2 },
        { label: "Manutenzione", data: manutenzioneClean, borderColor: "#64748b", backgroundColor: "#f1f5f9", spanGaps: true, tension: 0.2 },
        { label: "Internet", data: internetClean, borderColor: "#06b6d4", backgroundColor: "#cffaff", spanGaps: true, tension: 0.2 }
      ]
    },
    options: {
      responsive: true,
      scales: { y: { beginAtZero: true } }
    }
  });
}

function renderTenantChecks() {
  const state = window.getState ? window.getState() : { tenants: [] };
  const container = document.getElementById("expenseTenantChecks");
  if (!state.tenants.length) {
    container.innerHTML = '<p class="empty">Aggiungi prima almeno un inquilino a questo appartamento.</p>';
    return;
  }
  container.innerHTML = state.tenants.map(tenant => `
    <label class="check-item">
      <input type="checkbox" name="expenseTenants" value="${tenant.id}">
      ${escapeHtml(tenant.name)} ${tenant.room ? " — stanza " + escapeHtml(tenant.room) : ""}
    </label>`).join("");
}

function renderTenants() {
  const state = window.getState ? window.getState() : { tenants: [] };
  const container = document.getElementById("tenantsList");
  if (!state.tenants.length) {
    container.innerHTML = '<div class="card"><h2>Elenco inquilini</h2><p class="empty">Nessun inquilino presente in questo appartamento.</p></div>';
    return;
  }
  container.innerHTML = renderTenantGroups("tenants", state.tenants, list => `
    <div class="table-wrapper">
      <table>
        <thead><tr><th>Nome</th><th>Telefono</th><th>Stanza</th><th>Periodo contratto</th><th>Affitto</th><th>Azioni</th></tr></thead>
        <tbody>
          ${list.map(tenant => `
            <tr>
              <td>${escapeHtml(tenant.name)}</td>
              <td>${escapeHtml(tenant.phone || "-")}</td>
              <td>${escapeHtml(tenant.room || "-")}</td>
              <td>${formatMonth(tenant.contractStart)} - ${formatMonth(tenant.contractEnd)}</td>
              <td>${money(tenant.monthlyRent)}</td>
              <td class="actions-cell"><button class="btn-danger" onclick="deleteTenant('${tenant.id}')">Elimina</button></td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>`);
}

function renderExpenses() {
  const state = window.getState ? window.getState() : { expenses: [], tenants: [] };
  const container = document.getElementById("expensesList");
  const selectedYear = document.getElementById("yearFilterExpenses")?.value || "ALL";

  let filteredExpenses = state.expenses || [];
  if (selectedYear !== "ALL") {
    filteredExpenses = filteredExpenses.filter(e => e.date && e.date.startsWith(selectedYear));
  }

  if (!filteredExpenses.length) {
    container.innerHTML = '<p class="empty">Nessuna spesa trovata per i criteri selezionati.</p>';
    return;
  }

  const sorted = [...filteredExpenses].sort((a, b) => b.date.localeCompare(a.date));
  container.innerHTML = `
    <div class="table-wrapper">
      <table>
        <thead><tr><th>Data</th><th>Causale</th><th>Categoria</th><th>Totale</th><th>Inquilini</th><th>Quota indiv.</th><th>Azioni</th></tr></thead>
        <tbody>
          ${sorted.map(expense => {
            const names = expense.tenantIds.map(id => {
              const t = state.tenants.find(item => item.id === id);
              return t ? t.name : "Inquilino storico";
            });
            const share = expense.tenantIds.length ? expense.amount / expense.tenantIds.length : 0;
            return `
              <tr>
                <td>${formatDate(expense.date)}</td>
                <td><strong>${escapeHtml(expense.description)}</strong>${expense.notes ? `<br><small>${escapeHtml(expense.notes)}</small>` : ""}</td>
                <td>${escapeHtml(expense.category || "-")}</td>
                <td>${money(expense.amount)}</td>
                <td>${names.length ? names.map(escapeHtml).join("<br>") : "<small class='muted'>Generale</small>"}</td>
                <td>${money(share)}</td>
                <td class="actions-cell">
                  <button class="btn-whatsapp" onclick="sendExpenseWhatsApp('${expense.id}')" title="Notifica su WhatsApp">📱 Condividi</button>
                  <button class="btn-danger" onclick="deleteExpense('${expense.id}')">Elimina</button>
                </td>
              </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>`;
}

function renderRooms() {
  const state = window.getState ? window.getState() : { tenants: [] };
  const container = document.getElementById("roomsList");
  const selectedYear = document.getElementById("yearFilterRooms")?.value || "ALL";

  if (!state.tenants.length) {
    container.innerHTML = '<div class="card"><p class="empty">Aggiungi un inquilino per visualizzare le stanze.</p></div>';
    return;
  }

  container.innerHTML = renderTenantGroups("rooms", state.tenants,
    list => list.map(tenant => renderRoomCard(tenant, selectedYear)).join(""));
}

function renderRoomCard(tenant, selectedYear) {
  const summary = getTenantSummary(tenant, selectedYear);
  const due = Math.max(summary.balance, 0);

  // Gli id si basano sull'id dell'inquilino (non sulla posizione): lo stato aperto/chiuso resta valido
  const key = safeKey(tenant.id);
  const tenantCardContentId = `tenantCardContent_${key}`;
  const tenantArrowId = `tenantArrow_${key}`;
  const expContentId = `expContent_${key}`;
  const expArrowId = `expArrow_${key}`;
  const rentContentId = `rentContent_${key}`;
  const rentArrowId = `rentArrow_${key}`;
  const payContentId = `payContent_${key}`;
  const payArrowId = `payArrow_${key}`;

  return `
    <div class="card tenant-card">
      <div class="tenant-card-header" onclick="toggleSection('${tenantCardContentId}', '${tenantArrowId}')">
        <div class="tenant-card-title">
          <h2 style="margin: 0; display: inline-block;">${escapeHtml(tenant.name)}</h2>
          ${tenant.room ? `<span class="badge">Stanza ${escapeHtml(tenant.room)}</span>` : ""}
          <span class="${due > 0 ? "badge badge-danger" : "badge badge-success"}">${due > 0 ? "Da pagare " + money(due) : "Nessun importo dovuto"}</span>
        </div>
        <span id="${tenantArrowId}" class="arrow-icon">${arrowChar(tenantCardContentId)}</span>
      </div>

      <div id="${tenantCardContentId}" class="collapsible-content${openClass(tenantCardContentId)}">
        <p class="muted" style="margin-top: 10px;">Contratto: ${formatMonth(tenant.contractStart)} - ${formatMonth(tenant.contractEnd)} | Affitto mensile: ${money(tenant.monthlyRent)} | WhatsApp: ${escapeHtml(tenant.phone || "non inserito")}</p>

        <div class="stats">
          <div class="stat"><small>Spese (${selectedYear})</small><strong>${money(summary.totalExpenses)}</strong></div>
          <div class="stat"><small>Affitti maturati (${selectedYear})</small><strong>${money(summary.totalRent)}</strong></div>
          <div class="stat"><small>Totale dovuto (${selectedYear})</small><strong>${money(summary.totalDue)}</strong></div>
          <div class="stat"><small>Totale pagato (${selectedYear})</small><strong>${money(summary.totalPaid)}</strong></div>
          <div class="stat"><small>Da pagare</small><strong class="${due > 0 ? "positive" : "negative"}">${money(due)}</strong></div>
        </div>

        <!-- Sotto-sezione 1: Spese Personali -->
        <div class="sub-collapsible-header" onclick="toggleSection('${expContentId}', '${expArrowId}')">
          <h3>Spese personali (${selectedYear})</h3>
          <span id="${expArrowId}" class="arrow-icon">${arrowChar(expContentId)}</span>
        </div>
        <div id="${expContentId}" class="collapsible-content${openClass(expContentId)}">
          ${summary.expenses.length ? `<div class="table-wrapper"><table><thead><tr><th>Data</th><th>Causale</th><th>Quota</th></tr></thead><tbody>${summary.expenses.map(e => `<tr><td>${formatDate(e.date)}</td><td>${escapeHtml(e.description)}</td><td>${money(e.share)}</td></tr>`).join("")}</tbody></table></div>` : '<p class="empty">Nessuna spesa registrata per questo periodo.</p>'}
        </div>

        <!-- Sotto-sezione 2: Mensilità di affitto -->
        <div class="sub-collapsible-header" onclick="toggleSection('${rentContentId}', '${rentArrowId}')">
          <h3>Mensilità di affitto (${selectedYear})</h3>
          <span id="${rentArrowId}" class="arrow-icon">${arrowChar(rentContentId)}</span>
        </div>
        <div id="${rentContentId}" class="collapsible-content${openClass(rentContentId)}">
          ${summary.rentMonths.length ? `<div class="table-wrapper"><table><thead><tr><th>Mensilità</th><th>Importo</th></tr></thead><tbody>${summary.rentMonths.map(m => `<tr><td>${formatMonth(m)}</td><td>${money(tenant.monthlyRent)}</td></tr>`).join("")}</tbody></table></div>` : '<p class="empty">Nessuna mensilità per questo periodo.</p>'}
        </div>

        <!-- Sotto-sezione 3: Bonifici effettuati -->
        <div class="sub-collapsible-header" onclick="toggleSection('${payContentId}', '${payArrowId}')">
          <h3>Bonifici effettuati (${selectedYear})</h3>
          <span id="${payArrowId}" class="arrow-icon">${arrowChar(payContentId)}</span>
        </div>
        <div id="${payContentId}" class="collapsible-content${openClass(payContentId)}">
          ${summary.payments.length ? `<div class="table-wrapper"><table><thead><tr><th>Data</th><th>Causale</th><th>Importo</th><th>Azioni</th></tr></thead><tbody>${summary.payments.map(p => `<tr><td>${formatDate(p.date)}</td><td>${escapeHtml(p.description)}${p.notes ? `<br><small>${escapeHtml(p.notes)}</small>` : ""}</td><td>${money(p.amount)}</td><td><button class="btn-danger" onclick="deletePayment('${p.id}')">Elimina</button></td></tr>`).join("")}</tbody></table></div>` : '<p class="empty">Nessun bonifico registrato per questo periodo.</p>'}
        </div>

        <div class="actions" style="margin-top: 20px;">
          <button class="btn-primary" onclick="openPaymentModal('${tenant.id}')">Aggiungi bonifico</button>
          ${due > 0 && tenant.phone ? `<button class="btn-whatsapp" onclick="sendWhatsApp('${tenant.id}')">Invia promemoria WhatsApp</button>` : ""}
        </div>
      </div>
    </div>`;
}

function deleteAnnualDataPrompt() {
  const years = getAvailableYears();
  if (!years.length) { alert("Non ci sono dati disponibili da eliminare."); return; }

  const yearToDelete = prompt(`Inserisci l'anno per cui desideri ELIMINARE TUTTI I DATI (Spese e Bonifici).\n\nAnni disponibili: ${years.join(", ")}`);
  if (!yearToDelete) return;

  const cleanYear = yearToDelete.trim();
  if (!/^\d{4}$/.test(cleanYear)) { alert("Inserisci un anno valido nel formato AAAA (es. 2024)."); return; }

  const state = window.getState();
  const expensesToDelete = (state.expenses || []).filter(e => e.date && e.date.startsWith(cleanYear));
  const paymentsToDelete = (state.payments || []).filter(p => p.date && p.date.startsWith(cleanYear));

  if (expensesToDelete.length === 0 && paymentsToDelete.length === 0) {
    alert(`Nessuna spesa o bonifico trovato per l'anno ${cleanYear}.`);
    return;
  }

  if (confirm(`⚠️️ ATTENZIONE! Stai per eliminare DEFINITIVAMENTE:\n- ${expensesToDelete.length} Spese del ${cleanYear}\n- ${paymentsToDelete.length} Bonifici del ${cleanYear}\n\nConfermi l'eliminazione?`)) {
    state.expenses = (state.expenses || []).filter(e => !(e.date && e.date.startsWith(cleanYear)));
    state.payments = (state.payments || []).filter(p => !(p.date && p.date.startsWith(cleanYear)));
    
    window.save();
    alert(`Dati dell'anno ${cleanYear} eliminati con successo.`);
  }
}

function sendExpenseWhatsApp(expenseId) {
  const state = window.getState();
  const expense = state.expenses.find(e => e.id === expenseId);
  if (!expense) return;

  const tenantNames = expense.tenantIds.map(id => {
    const t = state.tenants.find(item => item.id === id);
    return t ? t.name : "Inquilino";
  });

  const share = expense.tenantIds.length ? expense.amount / expense.tenantIds.length : 0;

  let msg = `📌 *NUOVA SPESA REGISTRATA*\n\n`;
  msg += `🔹 *Causale:* ${expense.description}\n`;
  msg += `💶 *Importo totale:* ${money(expense.amount)}\n`;
  msg += `📅 *Data:* ${formatDate(expense.date)}\n`;
  if (expense.category) msg += `🏷️ *Categoria:* ${expense.category}\n`;
  msg += `\n👥 *Inquilini coinvolti:* ${tenantNames.length ? tenantNames.join(", ") : "Nessuno (Spesa generale)"}\n`;
  if (tenantNames.length) msg += `👉 *Quota a persona:* ${money(share)}\n`;
  if (expense.notes) msg += `\n📝 *Note:* ${expense.notes}\n`;

  window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(msg)}`, "_blank");
}

function exportDataToCSV() {
  const state = window.getState();
  if (!state) { alert("Nessun dato disponibile."); return; }

  const q = value => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const row = values => values.map(q).join(";") + "\n";

  const propName = document.getElementById("activePropertyName")?.textContent || "Appartamento";
  let csvContent = "\uFEFF";

  csvContent += "=== INQUILINI ===\n";
  csvContent += "ID;Nome;Telefono;Stanza;Affitto Mensile;Inizio Contratto;Fine Contratto;Note\n";
  (state.tenants || []).forEach(t => {
    csvContent += row([t.id, t.name, t.phone, t.room, t.monthlyRent || 0, t.contractStart, t.contractEnd, t.notes]);
  });

  csvContent += "\n=== SPESE APPARTAMENTO ===\n";
  csvContent += "ID;Data;Causale;Categoria;Importo Totale;ID Inquilini Coinvolti;Note\n";
  (state.expenses || []).forEach(e => {
    csvContent += row([e.id, e.date, e.description, e.category, e.amount || 0, (e.tenantIds || []).join(","), e.notes]);
  });

  csvContent += "\n=== BONIFICI INQUILINI ===\n";
  csvContent += "ID;ID Inquilino;Nome Inquilino;Data;Causale;Importo;Note\n";
  (state.payments || []).forEach(p => {
    const tenant = (state.tenants || []).find(t => t.id === p.tenantId);
    const tenantName = tenant ? tenant.name : "Sconosciuto";
    csvContent += row([p.id, p.tenantId, tenantName, p.date, p.description, p.amount || 0, p.notes]);
  });

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const fileName = `${propName.toLowerCase().replace(/\s+/g, "_")}_dati_${todayISO()}.csv`;

  link.setAttribute("href", url);
  link.setAttribute("download", fileName);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// Parser CSV con separatore ";" che gestisce i campi tra virgolette (anche con ";" o a capo all'interno)
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ";") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function importDataFromCSV(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const rows = parseCSV(e.target.result);

      const cleanId = v => String(v || "").replace(/[^A-Za-z0-9_-]/g, "_");
      const newId = prefix => prefix + "_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
      const toNumber = v => {
        let str = String(v ?? "").trim();
        if (str.includes(",")) str = str.replace(/\./g, "").replace(",", ".");
        return parseFloat(str) || 0;
      };

      let currentSection = "";
      let sectionsFound = 0;
      const newTenants = [];
      const newExpenses = [];
      const newPayments = [];

      rows.forEach(rawRow => {
        const cols = rawRow.map(col => col.trim());
        if (cols.every(col => col === "")) return;

        const first = cols[0];
        if (first.includes("=== INQUILINI ===")) { currentSection = "tenants"; sectionsFound++; return; }
        if (first.includes("=== SPESE APPARTAMENTO ===")) { currentSection = "expenses"; sectionsFound++; return; }
        if (first.includes("=== BONIFICI INQUILINI ===")) { currentSection = "payments"; sectionsFound++; return; }

        if (first === "ID" || first === "Nome") return;

        if (currentSection === "tenants" && cols.length >= 5) {
          newTenants.push({
            id: cleanId(cols[0]) || newId("tenant"),
            name: cols[1] || "",
            phone: cols[2] || "",
            room: cols[3] || "",
            monthlyRent: toNumber(cols[4]),
            contractStart: cols[5] || "",
            contractEnd: cols[6] || "",
            notes: cols[7] || ""
          });
        } else if (currentSection === "expenses" && cols.length >= 4) {
          newExpenses.push({
            id: cleanId(cols[0]) || newId("expense"),
            date: cols[1] || "",
            description: cols[2] || "",
            category: cols[3] || "Altro",
            amount: toNumber(cols[4]),
            tenantIds: cols[5] ? cols[5].split(",").map(x => cleanId(x.trim())).filter(x => x) : [],
            notes: cols[6] || ""
          });
        } else if (currentSection === "payments" && cols.length >= 4) {
          newPayments.push({
            id: cleanId(cols[0]) || newId("payment"),
            tenantId: cleanId(cols[1]),
            date: cols[3] || "",
            description: cols[4] || "",
            amount: toNumber(cols[5]),
            notes: cols[6] || ""
          });
        }
      });

      const totalRecords = newTenants.length + newExpenses.length + newPayments.length;

      if (sectionsFound === 0 && totalRecords === 0) {
        alert("Nessun dato valido trovato nel file. Verificare che il file sia salvato in formato CSV con separatore punto e virgola (;).");
        return;
      }

      const isEmptyImport = totalRecords === 0;
      const message = isEmptyImport
        ? "Il file non contiene dati.\n\nProseguendo verranno CANCELLATI tutti gli inquilini, le spese e i bonifici dell'appartamento corrente.\n\nVuoi azzerare l'appartamento?"
        : `Trovati ${newTenants.length} inquilini, ${newExpenses.length} spese e ${newPayments.length} bonifici.\n\nVuoi sovrascrivere i dati dell'appartamento corrente con questi?`;

      if (confirm(message)) {
        const state = window.getState();
        state.tenants = newTenants;
        state.expenses = newExpenses;
        state.payments = newPayments;

        window.save();
        alert(isEmptyImport ? "Appartamento azzerato con successo!" : "Importazione completata con successo!");
      }
    } catch (err) {
      alert("Errore durante l'importazione: " + err.message);
    }
  };

  reader.readAsText(file, "UTF-8");
  event.target.value = "";
}

function deleteTenant(id) {
  const state = window.getState();
  if (confirm("Eliminare questo inquilino?")) {
    state.tenants = state.tenants.filter(t => t.id !== id);
    window.save();
  }
}

function deleteExpense(id) {
  const state = window.getState();
  if (confirm("Eliminare questa spesa?")) {
    state.expenses = state.expenses.filter(e => e.id !== id);
    window.save();
  }
}

function deletePayment(id) {
  const state = window.getState();
  if (confirm("Eliminare questo bonifico?")) {
    state.payments = state.payments.filter(p => p.id !== id);
    window.save();
  }
}

function openPaymentModal(tenantId) {
  const state = window.getState();
  const tenant = state.tenants.find(t => t.id === tenantId);
  if (!tenant) return;
  document.getElementById("paymentTenantId").value = tenantId;
  document.getElementById("paymentTenantLabel").textContent = "Inquilino: " + tenant.name;
  document.getElementById("paymentDate").value = todayISO();
  document.getElementById("paymentModal").classList.add("open");
}

function closePaymentModal() { document.getElementById("paymentModal").classList.remove("open"); }

function sendWhatsApp(tenantId) {
  const state = window.getState();
  const tenant = state.tenants.find(t => t.id === tenantId);
  if (!tenant || !tenant.phone) return alert("Inserisci il numero WhatsApp.");
  const summary = getTenantSummary(tenant);
  const due = Math.max(summary.balance, 0);

  const msg = `Ciao ${tenant.name},\n\necco il riepilogo aggiornato.\n\nTotale dovuto: ${money(summary.totalDue)}\nTotale pagato: ${money(summary.totalPaid)}\nDa pagare: ${money(due)}\n\nGrazie.`;
  const phone = String(tenant.phone).replace(/\D/g, "").replace(/^0+/, "");
  window.open(`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`, "_blank");
}

// Il file è un modulo: le funzioni richiamate dagli attributi onclick/onchange dell'HTML vanno esposte su window
Object.assign(window, {
  toggleSection, toggleChartsToggle, exportDataToCSV, importDataFromCSV, deleteAnnualDataPrompt,
  sendExpenseWhatsApp, sendWhatsApp, deleteTenant, deleteExpense, deletePayment,
  openPaymentModal, closePaymentModal, renderDashboard, renderExpenses, renderRooms, renderAll
});

document.getElementById("tenantForm")?.addEventListener("submit", e => {
  e.preventDefault();
  const state = window.getState();
  const newTenant = {
    id: "tenant_" + Date.now(),
    name: document.getElementById("tenantName").value,
    phone: document.getElementById("tenantPhone").value,
    room: document.getElementById("tenantRoom").value,
    monthlyRent: parseFloat(document.getElementById("tenantRent").value) || 0,
    contractStart: document.getElementById("tenantStart").value,
    contractEnd: document.getElementById("tenantEnd").value,
    notes: document.getElementById("tenantNotes").value
  };
  state.tenants.push(newTenant);
  window.save();
  e.target.reset();
});

document.getElementById("expenseForm")?.addEventListener("submit", e => {
  e.preventDefault();
  const state = window.getState();
  const selectedTenants = Array.from(document.querySelectorAll("input[name='expenseTenants']:checked")).map(cb => cb.value);

  const newExpense = {
    id: "expense_" + Date.now(),
    description: document.getElementById("expenseDescription").value,
    amount: parseFloat(document.getElementById("expenseAmount").value) || 0,
    date: document.getElementById("expenseDate").value,
    category: document.getElementById("expenseCategory").value,
    tenantIds: selectedTenants,
    notes: document.getElementById("expenseNotes").value
  };

  state.expenses.push(newExpense);
  window.save();
  e.target.reset();
});

document.getElementById("paymentForm")?.addEventListener("submit", e => {
  e.preventDefault();
  const state = window.getState();
  const newPayment = {
    id: "payment_" + Date.now(),
    tenantId: document.getElementById("paymentTenantId").value,
    date: document.getElementById("paymentDate").value,
    amount: parseFloat(document.getElementById("paymentAmount").value) || 0,
    description: document.getElementById("paymentDescription").value,
    notes: document.getElementById("paymentNotes").value
  };

  state.payments.push(newPayment);
  window.save();
  closePaymentModal();
  e.target.reset();
});

document.querySelectorAll("nav button[data-page]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("nav button[data-page]").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.page).classList.add("active");
    renderAll();
  });
});

window.addEventListener("click", e => {
  if (e.target === document.getElementById("paymentModal")) closePaymentModal();
});
