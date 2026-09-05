/* =========================================
   CONFIG & STATE
   ========================================= */
const SUPABASE_URL = 'https://xhlfhnzrslvfsunjmzkg.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhobGZobnpyc2x2ZnN1bmptemtnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgwMDU4OTYsImV4cCI6MjEwMzU4MTg5Nn0.ClMkaq8Runl7mKAH3mUplQwpvSQefgzlWIIBDv8_lJI';
const db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const DEFAULT_SETTINGS = {
  bizName: 'EkPharma', license: '', gst: '', address: '',
  taxRate: 0, currency: '₹', lowStockThreshold: 10, expiryWarningDays: 90,
  blockExpired: true, soundEnabled: true
};

let session = null;
let authMode = 'login';
let inventory = [], invoices = [], cart = [];
let settings = { ...DEFAULT_SETTINGS };
let pending = { inventory: {}, invoices: {} };
let discount = 0, paymentMethod = 'Cash', stockFilter = 'all', editingBarcode = null, editingInvoiceId = null;
let syncInProgress = false, lastSyncError = null;
let realtimeChannels = [];

function $(id) { return document.getElementById(id); }
function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
function fmtMoney(n) { return settings.currency + Number(n || 0).toFixed(2); }
function fmtMoneyShort(n) { return settings.currency + Math.round(Number(n || 0)); }
function todayISO() { return new Date().toISOString().slice(0, 10); }
function isSameDay(a, b) { return !isNaN(a) && !isNaN(b) && a.toDateString() === b.toDateString(); }
function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return String(iso || '');
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) + ' · ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  const now = new Date(); now.setHours(0, 0, 0, 0);
  return Math.round((d - now) / 86400000);
}

/* =========================================
   AUTH
   ========================================= */
function setAuthMode(mode) {
  authMode = mode;
  $('tab-login').classList.toggle('active', mode === 'login');
  $('tab-signup').classList.toggle('active', mode === 'signup');
  $('field-pharmacy-name').style.display = mode === 'signup' ? 'block' : 'none';
  $('auth-submit-btn').innerText = mode === 'signup' ? 'Create account' : 'Log in';
  $('auth-foot').innerText = mode === 'signup'
    ? "Each pharmacy's data is completely private — you'll only ever see your own inventory, bills and invoices."
    : 'Welcome back — log in to your pharmacy.';
  $('auth-error').classList.remove('show');
  $('auth-note').classList.remove('show');
}
async function handleAuthSubmit() {
  const email = $('auth-email').value.trim();
  const password = $('auth-password').value;
  const errEl = $('auth-error'); errEl.classList.remove('show');
  $('auth-note').classList.remove('show');
  if (!email || !password) { errEl.innerText = 'Enter both email and password.'; errEl.classList.add('show'); return; }
  const btn = $('auth-submit-btn'); btn.disabled = true;
  try {
    if (authMode === 'signup') {
      const pharmacyName = $('auth-pharmacy-name').value.trim() || 'My Pharmacy';
      const { data, error } = await db.auth.signUp({ email, password });
      if (error) throw error;
      if (data.session) {
        session = data.session;
        await db.from('settings').upsert({ bizName: pharmacyName }, { onConflict: 'pharmacy_id' });
        onAuthed();
      } else {
        const noteEl = $('auth-note');
        noteEl.innerText = 'Account created! Check your email to confirm it, then log in.';
        noteEl.classList.add('show');
        setAuthMode('login');
      }
    } else {
      const { data, error } = await db.auth.signInWithPassword({ email, password });
      if (error) throw error;
      session = data.session;
      onAuthed();
    }
  } catch (err) {
    errEl.innerText = err.message || 'Something went wrong.';
    errEl.classList.add('show');
  } finally {
    btn.disabled = false;
  }
}
async function handleLogout() {
  const ok = await confirmDialog({ title: 'Log out?', message: 'You can log back in any time — your data stays safely in the cloud.', confirmText: 'Log Out', danger: true });
  if (!ok) return;
  realtimeChannels.forEach(ch => db.removeChannel(ch));
  realtimeChannels = [];
  await db.auth.signOut();
  session = null;
  inventory = []; invoices = []; cart = [];
  closeSettings();
  $('app-root').classList.remove('show');
  $('auth-screen').classList.remove('hide');
  setAuthMode('login');
}
function onAuthed() {
  $('auth-screen').classList.add('hide');
  $('app-root').classList.add('show');
  $('account-email-hint').innerText = 'Signed in as ' + (session.user && session.user.email);
  loadLocal();
  renderUI();
  loadCloudData();
  setupRealtime();
}
async function initAuth() {
  const { data } = await db.auth.getSession();
  session = data.session;
  if (session) onAuthed();
}

/* =========================================
   LOCAL CACHE (namespaced per pharmacy account —
   avoids one pharmacy's data leaking into another's
   cache on a shared/kiosk device)
   ========================================= */
function lsKey(base) { return base + ':' + (session && session.user ? session.user.id : 'anon'); }
function loadLocal() {
  try { inventory = JSON.parse(localStorage.getItem(lsKey('ek_inventory'))) || []; } catch (e) { inventory = []; }
  try { invoices = JSON.parse(localStorage.getItem(lsKey('ek_invoices'))) || []; } catch (e) { invoices = []; }
  try { pending = JSON.parse(localStorage.getItem(lsKey('ek_pending'))) || { inventory: {}, invoices: {} }; } catch (e) { pending = { inventory: {}, invoices: {} }; }
  try { settings = { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem(lsKey('ek_settings'))) || {}) }; } catch (e) { settings = { ...DEFAULT_SETTINGS }; }
}
function saveLocalInventory() { localStorage.setItem(lsKey('ek_inventory'), JSON.stringify(inventory)); }
function saveLocalInvoices() { localStorage.setItem(lsKey('ek_invoices'), JSON.stringify(invoices)); }
function savePending() { localStorage.setItem(lsKey('ek_pending'), JSON.stringify(pending)); }
function saveSettingsLocal() { localStorage.setItem(lsKey('ek_settings'), JSON.stringify(settings)); }

function pendingCount() { return Object.keys(pending.inventory).length + Object.keys(pending.invoices).length; }
function updateSyncIndicator() {
  const online = navigator.onLine;
  const dots = [$('sync-dot'), $('settings-sync-dot')];
  const label = pendingCount() > 0 ? (online ? 'Syncing…' : 'Offline — will sync') : (online ? 'Live' : 'Offline');
  const cls = !online ? 'offline' : (pendingCount() > 0 ? 'pending' : '');
  dots.forEach(d => { if (d) d.className = 'sync-dot ' + cls; });
  if ($('sync-label')) $('sync-label').innerText = label;
  if ($('settings-sync-label')) $('settings-sync-label').innerText = pendingCount() > 0 ? `${pendingCount()} item(s) pending sync` : 'Live';
  $('offline-banner').classList.toggle('show', !online);
}

/* =========================================
   CLOUD (multi-tenant: RLS scopes every query to the
   logged-in pharmacy automatically — no pharmacy_id
   needed in any payload below)
   ========================================= */
async function loadCloudData() {
  try {
    const { data, error } = await db.from('inventory').select('*');
    if (error) throw error;
    if (data) mergeInventory(data);
  } catch (err) { console.error('loadCloudData(inventory)', err); lastSyncError = err.message; }
  try {
    const { data, error } = await db.from('invoices').select('*');
    if (error) throw error;
    if (data) mergeInvoices(data);
  } catch (err) { console.error('loadCloudData(invoices)', err); lastSyncError = err.message; }
  try {
    const { data, error } = await db.from('settings').select('*').maybeSingle();
    if (error) throw error;
    if (data) { settings = { ...DEFAULT_SETTINGS, ...data }; saveSettingsLocal(); applySettingsToUI(); }
    else { await db.from('settings').upsert({}); }
  } catch (err) { console.error('loadCloudData(settings)', err); }
  updateSyncIndicator();
  renderUI();
}
function mergeInventory(cloudArr) {
  const byBarcode = {}; inventory.forEach(i => { byBarcode[i.barcode] = i; });
  cloudArr.forEach(ci => {
    const barcode = String(ci.barcode);
    if (pending.inventory[barcode]) return;
    byBarcode[barcode] = { barcode, name: String(ci.name || ''), batch: String(ci.batch || ''), mfg: ci.mfg || '', exp: ci.exp || '', qty: Number(ci.qty) || 0, price: Number(ci.price) || 0, mrp: Number(ci.mrp) || Number(ci.price) || 0, taxPct: Number(ci.taxPct) || 0 };
  });
  inventory = Object.values(byBarcode); saveLocalInventory();
}
function mergeInvoices(cloudArr) {
  const byId = {}; invoices.forEach(i => { byId[i.id] = i; });
  cloudArr.forEach(ci => { if (!pending.invoices[ci.id]) byId[ci.id] = ci; });
  invoices = Object.values(byId).sort((a, b) => new Date(b.date) - new Date(a.date));
  saveLocalInvoices();
}
async function syncInventoryItem(item) {
  try {
    const { error } = await db.from('inventory').upsert({ barcode: item.barcode, name: item.name, batch: item.batch, mfg: item.mfg, exp: item.exp, qty: item.qty, price: item.price, mrp: item.mrp, taxPct: item.taxPct }, { onConflict: 'pharmacy_id,barcode' });
    if (error) throw error;
    delete pending.inventory[item.barcode]; savePending(); lastSyncError = null; return true;
  } catch (err) { console.error('syncInventoryItem', err); lastSyncError = err.message; pending.inventory[item.barcode] = true; savePending(); return false; }
}
async function deleteInventoryCloud(barcode) {
  try { await db.from('inventory').delete().eq('barcode', barcode); } catch (e) { console.error(e); }
}
async function syncInvoiceRow(inv) {
  try {
    const { error } = await db.from('invoices').upsert(inv, { onConflict: 'pharmacy_id,id' });
    if (error) throw error;
    delete pending.invoices[inv.id]; savePending(); lastSyncError = null; return true;
  } catch (err) { console.error('syncInvoiceRow', err); lastSyncError = err.message; pending.invoices[inv.id] = true; savePending(); return false; }
}
async function deleteInvoiceCloud(id) { try { await db.from('invoices').delete().eq('id', id); } catch (e) {} }
async function syncSettingsToCloud() {
  try {
    await db.from('settings').upsert({
      bizName: settings.bizName, license: settings.license, gst: settings.gst, address: settings.address,
      taxRate: settings.taxRate, currency: settings.currency, lowStockThreshold: settings.lowStockThreshold, expiryWarningDays: settings.expiryWarningDays
    }, { onConflict: 'pharmacy_id' });
  } catch (err) { console.error('syncSettingsToCloud', err); }
}
async function flushPending() {
  if (syncInProgress || !navigator.onLine) return;
  syncInProgress = true;
  for (const bc of Object.keys(pending.inventory)) {
    const item = inventory.find(i => i.barcode === bc);
    if (item) await syncInventoryItem(item); else { delete pending.inventory[bc]; savePending(); }
  }
  for (const id of Object.keys(pending.invoices)) {
    const inv = invoices.find(i => i.id === id);
    if (inv) await syncInvoiceRow(inv); else { delete pending.invoices[id]; savePending(); }
  }
  syncInProgress = false; updateSyncIndicator();
}
async function manualSync() {
  toast('Syncing…', 'info', 1500);
  await flushPending(); await loadCloudData();
  toast(pendingCount() > 0 ? 'Some items still pending' : 'Sync complete', pendingCount() > 0 ? 'warn' : 'success');
}

/* =========================================
   REALTIME — filtered to this pharmacy's own rows only
   ========================================= */
function setupRealtime() {
  if (!session) return;
  const uid = session.user.id;
  realtimeChannels.push(
    db.channel('inv-' + uid).on('postgres_changes', { event: '*', schema: 'public', table: 'inventory', filter: 'pharmacy_id=eq.' + uid }, handleInventoryRealtime).subscribe(),
    db.channel('invc-' + uid).on('postgres_changes', { event: '*', schema: 'public', table: 'invoices', filter: 'pharmacy_id=eq.' + uid }, handleInvoiceRealtime).subscribe(),
    db.channel('set-' + uid).on('postgres_changes', { event: '*', schema: 'public', table: 'settings', filter: 'pharmacy_id=eq.' + uid }, handleSettingsRealtime).subscribe()
  );
}
function handleInventoryRealtime(payload) {
  if (payload.eventType === 'DELETE') { inventory = inventory.filter(i => i.barcode !== (payload.old && payload.old.barcode)); }
  else {
    const ci = payload.new; const barcode = String(ci.barcode);
    if (pending.inventory[barcode]) return;
    const item = { barcode, name: String(ci.name || ''), batch: String(ci.batch || ''), mfg: ci.mfg || '', exp: ci.exp || '', qty: Number(ci.qty) || 0, price: Number(ci.price) || 0, mrp: Number(ci.mrp) || Number(ci.price) || 0, taxPct: Number(ci.taxPct) || 0 };
    const idx = inventory.findIndex(i => i.barcode === barcode);
    if (idx > -1) inventory[idx] = item; else inventory.push(item);
  }
  saveLocalInventory(); renderUI();
}
function handleInvoiceRealtime(payload) {
  if (payload.eventType === 'DELETE') { invoices = invoices.filter(i => i.id !== (payload.old && payload.old.id)); }
  else {
    const ci = payload.new;
    if (pending.invoices[ci.id]) return;
    const idx = invoices.findIndex(i => i.id === ci.id);
    if (idx > -1) invoices[idx] = ci; else invoices.unshift(ci);
    invoices.sort((a, b) => new Date(b.date) - new Date(a.date));
  }
  saveLocalInvoices(); renderUI();
}
function handleSettingsRealtime(payload) {
  if (payload.eventType === 'DELETE') return;
  settings = { ...DEFAULT_SETTINGS, ...payload.new };
  saveSettingsLocal(); applySettingsToUI();
  toast('Pharmacy settings were updated', 'info', 2200);
}
function applySettingsToUI() { if ($('screen-settings').classList.contains('show')) populateSettingsForm(); renderUI(); }

window.addEventListener('online', () => { updateSyncIndicator(); flushPending(); toast('Back online — syncing changes', 'info'); });
window.addEventListener('offline', () => { updateSyncIndicator(); toast('You are offline. Changes will be saved locally.', 'warn'); });
setInterval(() => { if (pendingCount() > 0) flushPending(); }, 30000);

/* =========================================
   SOUND — short synthesized tones, no audio files needed.
   This is what plays the confirmation "beep" on a
   successful scan, and a lower error buzz on a failed one.
   ========================================= */
let audioCtx = null;
function ensureAudio() {
  if (!settings.soundEnabled) return null;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  } catch (e) { return null; }
}
function tone(freq, startOffset, dur, type, vol) {
  const ctx = ensureAudio(); if (!ctx) return;
  const osc = ctx.createOscillator(), gain = ctx.createGain();
  osc.type = type || 'sine'; osc.frequency.value = freq;
  const t0 = ctx.currentTime + startOffset;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(vol || 0.2, t0 + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0); osc.stop(t0 + dur + 0.02);
}
function playSuccess() { tone(1046, 0, 0.09, 'sine', 0.18); tone(1568, 0.08, 0.14, 'sine', 0.16); }
function playAdd() { tone(880, 0, 0.07, 'sine', 0.14); }
function playError() { tone(220, 0, 0.22, 'sawtooth', 0.14); }

/* =========================================
   TOASTS & CONFIRM
   ========================================= */
const TOAST_ICONS = {
  success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75M2.7 16.1c-.9 1.5.2 3.4 1.9 3.4h14.7c1.7 0 2.8-1.9 1.9-3.4L13.9 3.4c-.9-1.5-3-1.5-3.9 0L2.7 16.1z"/></svg>'
};
function toast(msg, type, duration) {
  type = type || 'info'; duration = duration || 3200;
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = `<span class="icon">${TOAST_ICONS[type] || TOAST_ICONS.info}</span><span>${escapeHtml(msg)}</span>`;
  $('toast-container').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .25s'; setTimeout(() => el.remove(), 250); }, duration);
}
function confirmDialog(opts) {
  return new Promise(resolve => {
    $('confirm-title').innerText = opts.title || 'Are you sure?';
    $('confirm-message').innerText = opts.message || '';
    const okBtn = $('confirm-ok-btn');
    okBtn.innerText = opts.confirmText || 'Confirm';
    okBtn.style.background = opts.danger ? 'var(--red)' : '';
    $('confirm-backdrop').classList.add('show');
    const cleanup = (val) => { $('confirm-backdrop').classList.remove('show'); okBtn.onclick = null; $('confirm-cancel-btn').onclick = null; resolve(val); };
    okBtn.onclick = () => cleanup(true);
    $('confirm-cancel-btn').onclick = () => cleanup(false);
  });
}

/* =========================================
   NAVIGATION
   ========================================= */
function switchTab(tab) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  $(`screen-${tab}`).classList.add('active');
  $(`nav-${tab}`).classList.add('active');
  if (tab === 'invoices') hideInvoiceDetail();
  if (tab === 'home') renderDashboard();
  if (tab === 'analytics') renderAnalytics();
}
function openSettings() { populateSettingsForm(); $('screen-settings').classList.add('show'); }
function closeSettings() { $('screen-settings').classList.remove('show'); }

/* =========================================
   SCANNER
   ========================================= */
let html5QrCode = null, scannerTarget = null, scanCameras = [], scanCameraIndex = 0, torchOn = false, lastScanCode = '', lastScanTime = 0;

async function startScanner(target) {
  scannerTarget = target;
  $('scanner-error').style.display = 'none';
  $('scanner-manual-input').value = '';
  $('scanner-container').style.display = 'flex';
  $('scanner-hint').innerText = target === 'bill' ? 'Align barcode to add to cart' : 'Align barcode to add/edit stock';
  torchOn = false;
  $('camera-switch-btn').style.display = 'none'; // rear camera only — no front-camera option to switch to
  html5QrCode = new Html5Qrcode("reader");
  const config = { fps: 12, qrbox: { width: 260, height: 160 } };
  const onSuccess = (decodedText) => onScanSuccess(decodedText, target);

  // Force the rear/back camera specifically. Enumerating cameras and picking
  // index 0 is NOT reliable — many phones list the front camera first, which
  // was the cause of the front camera showing up before this fix.
  try {
    await html5QrCode.start({ facingMode: { exact: "environment" } }, config, onSuccess);
    checkTorchSupport();
    return;
  } catch (e1) { /* fall through */ }
  try {
    await html5QrCode.start({ facingMode: "environment" }, config, onSuccess);
    checkTorchSupport();
    return;
  } catch (e2) { /* fall through */ }
  try {
    scanCameras = await Html5Qrcode.getCameras();
    const backCam = scanCameras.find(c => !/front|user|face|selfie/i.test(c.label)) || scanCameras[scanCameras.length - 1];
    if (!backCam) throw new Error('No camera found');
    await html5QrCode.start({ deviceId: { exact: backCam.id } }, config, onSuccess);
    checkTorchSupport();
  } catch (e3) {
    showScannerError("Camera access denied or unavailable. Type the barcode below instead.");
  }
}
function onScanSuccess(decodedText, target) {
  const now = Date.now();
  if (decodedText === lastScanCode && (now - lastScanTime) < 1600) return;
  lastScanCode = decodedText; lastScanTime = now;
  if (target === 'stock') stopScanner();
  processBarcode(decodedText, target);
}
function showScannerError(msg) { const el = $('scanner-error'); el.innerText = msg; el.style.display = 'block'; }
async function checkTorchSupport() {
  try {
    const capabilities = html5QrCode._localMediaStream ? html5QrCode._localMediaStream.getVideoTracks()[0].getCapabilities() : null;
    $('torch-btn').style.display = (capabilities && capabilities.torch) ? 'flex' : 'none';
  } catch (e) { $('torch-btn').style.display = 'none'; }
}
async function toggleTorch() {
  try { torchOn = !torchOn; await html5QrCode.applyVideoConstraints({ advanced: [{ torch: torchOn }] }); }
  catch (e) { toast('Flash not supported on this device', 'warn'); }
}
async function switchCamera() {
  if (scanCameras.length < 2) return;
  scanCameraIndex = (scanCameraIndex + 1) % scanCameras.length;
  await stopScannerInternal(); startScanner(scannerTarget);
}
async function stopScannerInternal() { if (html5QrCode) { try { await html5QrCode.stop(); html5QrCode.clear(); } catch (e) {} } }
function stopScanner() { $('scanner-container').style.display = 'none'; stopScannerInternal(); }
function handleScannerManual() {
  const val = $('scanner-manual-input').value.trim();
  if (!val) return;
  processBarcode(val, scannerTarget);
  $('scanner-manual-input').value = '';
  stopScanner();
}
function handleManual(target) {
  const el = $(`manual-${target}`);
  if (el.value.trim()) { processBarcode(el.value.trim(), target); el.value = ''; }
}

/* =========================================
   BARCODE PROCESSING
   ========================================= */
function processBarcode(code, target) {
  const cleanCode = String(code).trim();
  if (!cleanCode) return;
  if (target === 'bill') {
    const item = inventory.find(i => i.barcode === cleanCode);
    if (!item) { playError(); toast(`Barcode "${cleanCode}" not found in inventory.`, 'error'); return; }
    if (item.qty <= 0) { playError(); toast(`${item.name} is out of stock.`, 'error'); return; }
    if (settings.blockExpired && item.exp) {
      const d = daysUntil(item.exp);
      if (d !== null && d < 0) { playError(); toast(`${item.name} has expired (Batch ${item.batch || 'N/A'}). Sale blocked.`, 'error', 4200); return; }
    }
    const cartItem = cart.find(c => c.barcode === cleanCode);
    if (cartItem) {
      if (cartItem.qty < item.qty) { cartItem.qty++; playAdd(); }
      else { playError(); toast('Stock limit reached for this item.', 'warn'); return; }
    } else { cart.push({ ...item, qty: 1 }); playSuccess(); }
    toast(`${item.name} added to cart`, 'success', 1600);
    renderUI();
  } else if (target === 'stock') {
    playSuccess();
    editingBarcode = null;
    $('add-stock-form').style.display = 'block';
    $('st-code').value = cleanCode;
    const existing = inventory.find(i => i.barcode === cleanCode);
    if (existing) {
      editingBarcode = existing.barcode;
      $('stock-form-title').innerText = 'Edit Medicine';
      $('st-name').value = existing.name; $('st-batch').value = existing.batch;
      $('st-mfg').value = existing.mfg; $('st-exp').value = existing.exp;
      $('st-qty').value = existing.qty; $('st-price').value = existing.price;
      $('st-mrp').value = existing.mrp != null ? existing.mrp : existing.price;
      $('st-tax').value = existing.taxPct != null ? existing.taxPct : settings.taxRate;
      $('btn-delete-stock').style.display = 'flex';
      toast(`Editing existing item: ${existing.name}`, 'info', 2000);
    } else {
      $('stock-form-title').innerText = 'New Medicine';
      $('st-name').value = ''; $('st-batch').value = '';
      $('st-mfg').value = ''; $('st-exp').value = '';
      $('st-qty').value = ''; $('st-price').value = '';
      $('st-mrp').value = ''; $('st-tax').value = settings.taxRate || '';
      $('btn-delete-stock').style.display = 'none';
      lookupProductName(cleanCode);
    }
    updateExpHint();
    $('add-stock-form').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    $('st-name').focus();
  }
}
async function lookupProductName(barcode) {
  const nameField = $('st-name');
  const originalPlaceholder = nameField.placeholder;
  nameField.placeholder = 'Looking up product online…';
  try {
    const res = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(barcode)}`);
    if (res.ok) {
      const data = await res.json();
      const title = data && data.items && data.items[0] && data.items[0].title;
      if (title && !nameField.value && $('st-code').value.trim() === barcode) {
        nameField.value = title;
        toast('Product name auto-filled — please verify', 'info', 2800);
      }
    }
  } catch (e) { /* most Indian pharma barcodes won't be listed — silent fallback to manual entry */ }
  finally { nameField.placeholder = originalPlaceholder; }
}
function openAddStockForm() {
  editingBarcode = null;
  $('add-stock-form').style.display = 'block';
  $('stock-form-title').innerText = 'New Medicine';
  ['st-code', 'st-name', 'st-batch', 'st-mfg', 'st-exp', 'st-qty', 'st-price', 'st-mrp', 'st-tax'].forEach(id => $(id).value = '');
  $('st-tax').value = settings.taxRate || '';
  $('btn-delete-stock').style.display = 'none';
  updateExpHint();
  $('add-stock-form').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  $('st-code').focus();
}
function closeStockForm() { $('add-stock-form').style.display = 'none'; editingBarcode = null; }
document.addEventListener('input', (e) => { if (e.target && e.target.id === 'st-exp') updateExpHint(); });
function updatePriceHint() {
  const mrp = parseFloat($('st-mrp').value), price = parseFloat($('st-price').value);
  const el = $('price-hint');
  if (isNaN(mrp) || isNaN(price) || mrp <= 0) { el.innerText = ''; return; }
  if (price > mrp) { el.innerHTML = '<span style="color:var(--red);font-weight:700;">Selling price is above MRP.</span>'; return; }
  const disc = Math.round((1 - price / mrp) * 100);
  el.innerHTML = disc > 0
    ? `<span style="color:var(--green-dark);font-weight:700;">${disc}% off MRP</span>`
    : 'Selling at MRP';
}
function updateExpHint() {
  const exp = $('st-exp').value; const hintEl = $('exp-hint');
  if (!exp) { hintEl.innerText = ''; return; }
  const d = daysUntil(exp);
  if (d < 0) hintEl.innerHTML = '<span style="color:var(--red);font-weight:700;">This date is already in the past.</span>';
  else if (d <= settings.expiryWarningDays) hintEl.innerHTML = `<span style="color:var(--amber);font-weight:700;">Expires in ${d} day(s).</span>`;
  else hintEl.innerText = `Expires in ${d} days.`;
}

/* =========================================
   STOCK CRUD
   ========================================= */
async function saveStock() {
  const barcode = String($('st-code').value).trim();
  const name = $('st-name').value.trim();
  const batch = $('st-batch').value.trim();
  const mfg = $('st-mfg').value, exp = $('st-exp').value;
  const qty = parseInt($('st-qty').value, 10), price = parseFloat($('st-price').value);
  const mrp = parseFloat($('st-mrp').value);
  const taxPct = parseFloat($('st-tax').value) || 0;
  let valid = true;
  [['err-st-name', !name], ['err-st-qty', isNaN(qty) || qty < 0], ['err-st-price', isNaN(price) || price < 0], ['err-st-mrp', isNaN(mrp) || mrp < 0]]
    .forEach(([id, bad]) => { $(id).style.display = bad ? 'block' : 'none'; if (bad) valid = false; });
  [['st-name', !name], ['st-qty', isNaN(qty) || qty < 0], ['st-price', isNaN(price) || price < 0], ['st-mrp', isNaN(mrp) || mrp < 0]]
    .forEach(([id, bad]) => $(id).classList.toggle('err', bad));
  if (!barcode) { toast('Barcode is required — scan or type one.', 'error'); return; }
  if (!valid) { toast('Please fix the highlighted fields.', 'error'); return; }
  const newItem = { barcode, name, batch, mfg, exp, qty, price, mrp, taxPct };
  const idx = inventory.findIndex(i => i.barcode === barcode);
  if (idx > -1) inventory[idx] = newItem; else inventory.push(newItem);
  saveLocalInventory();
  pending.inventory[barcode] = true; savePending();
  renderUI();
  closeStockForm();
  toast('Saved to inventory', 'success');
  const ok = await syncInventoryItem(newItem);
  updateSyncIndicator();
  if (!ok) toast('Saved locally. Will sync when online.', 'warn', 3000);
}
async function deleteStockConfirm() {
  const item = inventory.find(i => i.barcode === editingBarcode);
  if (!item) return;
  const ok = await confirmDialog({ title: 'Remove this medicine?', message: `${item.name} will be permanently removed from inventory.`, confirmText: 'Remove', danger: true });
  if (!ok) return;
  inventory = inventory.filter(i => i.barcode !== editingBarcode);
  saveLocalInventory();
  delete pending.inventory[editingBarcode]; savePending();
  deleteInventoryCloud(editingBarcode);
  closeStockForm(); renderUI();
  toast('Medicine removed', 'success');
}
function setStockFilter(f) {
  stockFilter = f;
  document.querySelectorAll('.chip[data-filter]').forEach(c => c.classList.toggle('active', c.dataset.filter === f));
  renderUI();
}
function discPctOf(item) {
  if (!item.mrp || item.mrp <= item.price) return 0;
  return Math.round((1 - item.price / item.mrp) * 100);
}
function computeStockStatus(item) {
  if (item.qty <= 0) return { strip: 'status-danger', cls: 'badge-danger', label: 'Out of stock' };
  const d = item.exp ? daysUntil(item.exp) : null;
  if (d !== null && d < 0) return { strip: 'status-danger', cls: 'badge-danger', label: 'Expired' };
  if (d !== null && d <= settings.expiryWarningDays) return { strip: 'status-warn', cls: 'badge-warn', label: `Exp in ${d}d` };
  if (item.qty <= settings.lowStockThreshold) return { strip: 'status-warn', cls: 'badge-warn', label: 'Low stock' };
  return { strip: 'status-strip', cls: 'badge-ok', label: 'OK' };
}

/* =========================================
   CART
   ========================================= */
function updateCartQty(barcode, delta) {
  const idx = cart.findIndex(c => c.barcode === barcode);
  if (idx > -1) {
    if (delta === -9999) cart.splice(idx, 1);
    else {
      const inv = inventory.find(i => i.barcode === barcode);
      const newQty = cart[idx].qty + delta;
      if (newQty <= 0) cart.splice(idx, 1);
      else if (inv && newQty > inv.qty) { toast('Exceeds available stock!', 'warn'); return; }
      else cart[idx].qty = newQty;
    }
    renderUI();
  }
}
function clearCart() { if (!cart.length) return; cart = []; renderUI(); toast('Cart cleared', 'info', 1500); }
function setPaymentMethod(m) { paymentMethod = m; document.querySelectorAll('.pay-chip').forEach(c => c.classList.toggle('active', c.dataset.pay === m)); }
function computeCartTotals() {
  const totalMRP = cart.reduce((s, c) => s + ((c.mrp || c.price) * c.qty), 0);
  const subtotal = cart.reduce((s, c) => s + (c.price * c.qty), 0);
  const savings = Math.max(totalMRP - subtotal, 0);
  const tax = cart.reduce((s, c) => s + (c.price * c.qty * ((c.taxPct || 0) / 100)), 0);
  const additionalDiscount = Math.min(Math.max(parseFloat($('cart-discount') ? $('cart-discount').value : 0) || 0, 0), subtotal + tax);
  const total = Math.max(subtotal + tax - additionalDiscount, 0);
  return { totalMRP, subtotal, savings, tax, additionalDiscount, total };
}
async function generateInvoice() {
  if (!cart.length) return;
  const custName = $('cust-name').value.trim() || 'Walk-in Customer';
  const custPhone = $('cust-phone').value.trim() || 'N/A';
  const totals = computeCartTotals();
  for (const c of cart) {
    const inv = inventory.find(i => i.barcode === c.barcode);
    if (!inv || inv.qty < c.qty) { toast(`Not enough stock for ${c.name}. Please refresh cart.`, 'error'); return; }
  }
  cart.forEach(c => { const inv = inventory.find(i => i.barcode === c.barcode); if (inv) inv.qty -= c.qty; });
  saveLocalInventory();
  cart.forEach(c => { pending.inventory[c.barcode] = true; });
  savePending();

  const id = 'OP-' + Math.floor(100000 + Math.random() * 900000);
  const date = new Date().toISOString();
  const invoice = { id, date, customerName: custName, customerPhone: custPhone, items: [...cart], totalMRP: totals.totalMRP, subtotal: totals.subtotal, savings: totals.savings, tax: totals.tax, discount: totals.additionalDiscount, paymentMethod, total: totals.total };
  invoices.unshift(invoice); saveLocalInvoices();
  pending.invoices[id] = true; savePending();

  cart = []; discount = 0;
  $('cust-name').value = ''; $('cust-phone').value = '';
  if ($('cart-discount')) $('cart-discount').value = '';
  renderUI();
  toast(`Invoice ${id} created — ${fmtMoney(totals.total)}`, 'success');
  switchTab('invoices');

  const invOk = await syncInvoiceRow(invoice);
  for (const c of invoice.items) { const item = inventory.find(i => i.barcode === c.barcode); if (item) await syncInventoryItem(item); }
  updateSyncIndicator();
  if (!invOk) toast('Invoice saved locally. Will sync when online.', 'warn', 3500);
}

/* =========================================
   INVOICES
   ========================================= */
function viewInvoice(id) {
  const inv = invoices.find(i => i.id === id);
  if (!inv) return;
  $('invoice-list-view').style.display = 'none';
  $('invoice-detail-view').style.display = 'block';
  $('det-id').innerText = '#' + inv.id;
  $('det-date').innerText = fmtDate(inv.date);
  $('det-cust-name').innerText = inv.customerName;
  $('det-cust-phone').innerText = inv.customerPhone;
  $('det-pay').innerText = inv.paymentMethod || 'Cash';
  $('det-total').innerText = inv.total.toFixed(2);
  const subtotal = inv.subtotal != null ? inv.subtotal : inv.items.reduce((s, i) => s + i.price * i.qty, 0);
  const totalMRP = inv.totalMRP != null ? inv.totalMRP : inv.items.reduce((s, i) => s + (i.mrp || i.price) * i.qty, 0);
  const savings = inv.savings != null ? inv.savings : Math.max(totalMRP - subtotal, 0);
  const disc = inv.discount || 0, tax = inv.tax || 0;
  $('det-mrp').innerText = fmtMoney(totalMRP);
  if (savings > 0.004) { $('det-savings-row').style.display = 'flex'; $('det-savings').innerText = fmtMoney(savings); }
  else $('det-savings-row').style.display = 'none';
  $('det-subtotal').innerText = fmtMoney(subtotal);
  if (disc > 0.004) { $('det-discount-row').style.display = 'flex'; $('det-discount').innerText = '-' + fmtMoney(disc); }
  else $('det-discount-row').style.display = 'none';
  if (tax > 0.004) { $('det-tax-row').style.display = 'flex'; $('det-tax').innerText = fmtMoney(tax); }
  else $('det-tax-row').style.display = 'none';
  $('det-items').innerHTML = inv.items.map(i => `
    <tr><td>${escapeHtml(i.name)}<br><small style="color:var(--muted)">Batch: ${escapeHtml(i.batch || 'N/A')}</small></td>
      <td style="text-align:right" class="mono">${fmtMoney(i.mrp || i.price)}</td>
      <td style="text-align:right" class="mono">${fmtMoney(i.price)}</td>
      <td style="text-align:right" class="mono">${i.qty}</td>
      <td style="text-align:right" class="mono">${i.taxPct || 0}%</td>
      <td style="text-align:right" class="mono">${fmtMoney(i.qty * i.price)}</td></tr>
  `).join('');
  $('btn-download-pdf').onclick = () => downloadInvoicePdf(inv);
  editingInvoiceId = inv.id;
}
function hideInvoiceDetail() { $('invoice-list-view').style.display = 'block'; $('invoice-detail-view').style.display = 'none'; }
async function deleteInvoiceConfirm() {
  const inv = invoices.find(i => i.id === editingInvoiceId);
  if (!inv) return;
  const ok = await confirmDialog({ title: 'Delete this invoice?', message: `Invoice #${inv.id} will be permanently removed. This does not restore inventory quantities.`, confirmText: 'Delete', danger: true });
  if (!ok) return;
  invoices = invoices.filter(i => i.id !== inv.id);
  saveLocalInvoices();
  delete pending.invoices[inv.id]; savePending();
  deleteInvoiceCloud(inv.id);
  hideInvoiceDetail(); renderUI();
  toast('Invoice deleted', 'success');
}

/* =========================================
   PDF — vector text drawn directly with jsPDF + autoTable
   ========================================= */
function downloadInvoicePdf(inv) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 42;
  const navy = [27, 63, 139];
  const green = [18, 150, 90];
  const muted = [94, 107, 98];
  const ink = [22, 33, 27];
  const lightBand = [225, 244, 234];

  // Header — brand-color wordmark on white, thin two-tone rule beneath (mirrors the real logo)
  doc.setFillColor(...green); doc.rect(0, 0, pageWidth * 0.5, 4, 'F');
  doc.setFillColor(...navy); doc.rect(pageWidth * 0.5, 0, pageWidth * 0.5, 4, 'F');

  doc.setFont('helvetica', 'bold'); doc.setFontSize(22);
  doc.setTextColor(...green); doc.text('Ek', margin, 42);
  const ekWidth = doc.getTextWidth('Ek');
  doc.setTextColor(...navy); doc.text('Pharma', margin + ekWidth, 42);

  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...muted);
  let hy = 60;
  [settings.bizName, settings.license, settings.address, settings.gst ? 'GSTIN: ' + settings.gst : ''].filter(Boolean).forEach(line => { doc.text(line, margin, hy); hy += 12; });

  doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(...navy);
  doc.text('TAX INVOICE', pageWidth - margin, 38, { align: 'right' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...muted);
  doc.text('#' + inv.id, pageWidth - margin, 54, { align: 'right' });
  doc.text(fmtDate(inv.date), pageWidth - margin, 67, { align: 'right' });
  doc.text('Payment: ' + (inv.paymentMethod || 'Cash'), pageWidth - margin, 80, { align: 'right' });
  doc.setDrawColor(230, 227, 216); doc.setLineWidth(0.75);
  doc.line(margin, 96, pageWidth - margin, 96);

  let y = 128;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(...muted);
  doc.text('BILLED TO', margin, y);
  y += 15;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(12.5); doc.setTextColor(...ink);
  doc.text(inv.customerName || 'Walk-in Customer', margin, y);
  if (inv.customerPhone && inv.customerPhone !== 'N/A') {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...muted);
    doc.text(inv.customerPhone, margin, y + 14);
  }
  y += 32;

  // Items table
  const rows = inv.items.map(it => [
    it.name + (it.batch ? `\nBatch: ${it.batch}` : ''),
    fmtMoney(it.mrp || it.price), fmtMoney(it.price), String(it.qty), `${it.taxPct || 0}%`, fmtMoney(it.qty * it.price)
  ]);
  doc.autoTable({
    startY: y,
    margin: { left: margin, right: margin },
    head: [['Item', 'MRP', 'Rate', 'Qty', 'GST', 'Amount']],
    body: rows,
    styles: { font: 'helvetica', fontSize: 9.5, textColor: ink, cellPadding: 7, lineColor: [230, 227, 216], lineWidth: 0.5 },
    headStyles: { fillColor: navy, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 9 },
    alternateRowStyles: { fillColor: [250, 248, 242] },
    columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right', fontStyle: 'bold' } }
  });

  let finalY = doc.lastAutoTable.finalY + 18;
  const totalMRP = inv.totalMRP != null ? inv.totalMRP : inv.items.reduce((s, i) => s + (i.mrp || i.price) * i.qty, 0);
  const subtotal = inv.subtotal != null ? inv.subtotal : inv.items.reduce((s, i) => s + i.price * i.qty, 0);
  const savings = inv.savings != null ? inv.savings : Math.max(totalMRP - subtotal, 0);
  const disc = inv.discount || 0, tax = inv.tax || 0;

  const summaryRows = [['MRP Total', fmtMoney(totalMRP)]];
  if (savings > 0.004) summaryRows.push(['You Saved', '-' + fmtMoney(savings)]);
  summaryRows.push(['Taxable Value', fmtMoney(subtotal)]);
  if (tax > 0.004) summaryRows.push(['GST', fmtMoney(tax)]);
  if (disc > 0.004) summaryRows.push(['Additional Discount', '-' + fmtMoney(disc)]);

  if (finalY + summaryRows.length * 20 + 80 > pageHeight - margin) { doc.addPage(); finalY = margin; }

  const boxWidth = 230, boxX = pageWidth - margin - boxWidth;
  doc.autoTable({
    startY: finalY,
    margin: { left: boxX },
    tableWidth: boxWidth,
    theme: 'plain',
    body: summaryRows,
    styles: { font: 'helvetica', fontSize: 9.5, textColor: muted, cellPadding: { top: 3, bottom: 3, left: 0, right: 0 } },
    columnStyles: { 0: { halign: 'left' }, 1: { halign: 'right', textColor: ink, fontStyle: 'bold' } }
  });
  let afterY = doc.lastAutoTable.finalY + 8;
  doc.setFillColor(...lightBand);
  doc.rect(boxX, afterY, boxWidth, 30, 'F');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(...navy);
  doc.text('Total', boxX + 10, afterY + 20);
  doc.text(fmtMoney(inv.total), boxX + boxWidth - 10, afterY + 20, { align: 'right' });

  const footY = pageHeight - 40;
  doc.setDrawColor(230, 227, 216); doc.setLineWidth(0.5);
  doc.line(margin, footY - 14, pageWidth - margin, footY - 14);
  doc.setFont('helvetica', 'italic'); doc.setFontSize(9); doc.setTextColor(...muted);
  doc.text('Thank you for your business — get well soon.', margin, footY);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
  doc.text('Generated by EkPharma', pageWidth - margin, footY, { align: 'right' });

  doc.save(`Invoice_${inv.id}.pdf`);
  toast('PDF downloaded', 'success');
}

/* =========================================
   SETTINGS
   ========================================= */
function populateSettingsForm() {
  $('set-biz-name').value = settings.bizName;
  $('set-license').value = settings.license;
  $('set-gst').value = settings.gst;
  $('set-address').value = settings.address;
  $('set-tax-rate').value = settings.taxRate;
  $('set-currency').value = settings.currency;
  $('set-low-stock').value = settings.lowStockThreshold;
  $('set-exp-days').value = settings.expiryWarningDays;
  $('set-block-expired').checked = settings.blockExpired;
  $('set-sound-enabled').checked = settings.soundEnabled;
}
function saveSettingsForm() {
  settings.bizName = $('set-biz-name').value.trim() || 'EkPharma';
  settings.license = $('set-license').value.trim();
  settings.gst = $('set-gst').value.trim();
  settings.address = $('set-address').value.trim();
  settings.taxRate = parseFloat($('set-tax-rate').value) || 0;
  settings.currency = $('set-currency').value.trim() || '₹';
  settings.lowStockThreshold = parseInt($('set-low-stock').value, 10) || 0;
  settings.expiryWarningDays = parseInt($('set-exp-days').value, 10) || 0;
  settings.blockExpired = $('set-block-expired').checked;
  settings.soundEnabled = $('set-sound-enabled').checked;
  saveSettingsLocal();
  renderUI();
  toast('Settings saved', 'success');
  syncSettingsToCloud();
}

function exportInventoryCSV() {
  if (!inventory.length) { toast('No inventory to export', 'warn'); return; }
  const header = ['Barcode', 'Name', 'Batch', 'Mfg Date', 'Expiry Date', 'Quantity', 'MRP', 'Selling Price', 'Discount %', 'GST %'];
  const rows = inventory.map(i => [i.barcode, i.name, i.batch, i.mfg, i.exp, i.qty, i.mrp || i.price, i.price, discPctOf(i), i.taxPct || 0]);
  const csv = [header, ...rows].map(r => r.map(v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `EkPharma_Inventory_${todayISO()}.csv`; a.click();
  URL.revokeObjectURL(url); toast('Inventory CSV downloaded', 'success');
}
function exportInvoicesCSV() {
  if (!invoices.length) { toast('No invoices to export', 'warn'); return; }
  const header = ['Invoice ID', 'Date', 'Customer Name', 'Customer Phone', 'Payment Method', 'MRP Total', 'You Saved', 'Taxable Value', 'GST', 'Additional Discount', 'Total', 'Items'];
  const rows = invoices.map(i => [i.id, fmtDate(i.date), i.customerName, i.customerPhone, i.paymentMethod || 'Cash', i.totalMRP || 0, i.savings || 0, i.subtotal, i.tax || 0, i.discount || 0, i.total, (i.items || []).map(it => `${it.name} x${it.qty}`).join('; ')]);
  const csv = [header, ...rows].map(r => r.map(v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `EkPharma_Invoices_${todayISO()}.csv`; a.click();
  URL.revokeObjectURL(url); toast('Invoices CSV downloaded', 'success');
}

/* =========================================
   RENDER — DASHBOARD
   ========================================= */
function renderDashboard() {
  const now = new Date();
  $('home-biz-name').innerText = settings.bizName || 'Welcome back';
  $('home-date-sub').innerText = now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const todaySales = invoices.filter(i => { const d = new Date(i.date); return !isNaN(d) && isSameDay(d, now); }).reduce((s, i) => s + i.total, 0);
  $('stat-today-sales').innerText = fmtMoney(todaySales);
  const invValue = inventory.reduce((s, i) => s + i.qty * i.price, 0);
  $('stat-inv-value').innerText = fmtMoney(invValue);
  const lowCount = inventory.filter(i => i.qty > 0 && i.qty <= settings.lowStockThreshold).length;
  $('stat-low-stock').innerText = lowCount;
  $('alert-low-count').innerText = lowCount;
  const expCount = inventory.filter(i => { if (!i.exp) return false; const d = daysUntil(i.exp); return d !== null && d >= 0 && d <= settings.expiryWarningDays; }).length;
  $('stat-expiring').innerText = expCount;
  $('alert-exp-count').innerText = expCount;
  renderSalesTrend(now, 'sales-trend-chart');
  renderRecentInvoices();
}
function renderSalesTrend(now, targetId) {
  const days = [];
  for (let i = 6; i >= 0; i--) { const d = new Date(now); d.setDate(d.getDate() - i); d.setHours(0, 0, 0, 0); days.push(d); }
  const totals = days.map(d => invoices.reduce((s, inv) => { const invDate = new Date(inv.date); return (!isNaN(invDate) && isSameDay(invDate, d)) ? s + inv.total : s; }, 0));
  const max = Math.max(...totals, 1);
  const el = $(targetId);
  if (!el) return;
  if (invoices.length === 0) { el.innerHTML = `<div class="empty-state" style="padding:20px;"><p>No sales yet — your first invoice will show up here.</p></div>`; return; }
  el.innerHTML = `<div class="trend-row">${days.map((d, i) => {
    const heightPct = Math.max((totals[i] / max) * 100, 2);
    const isToday = isSameDay(d, now);
    return `<div class="trend-bar-wrap" title="${fmtMoney(totals[i])}"><div class="trend-bar-amt">${totals[i] > 0 ? Math.round(totals[i]) : ''}</div><div class="trend-bar ${isToday ? 'today' : ''}" style="height:${heightPct}%;"></div><div class="trend-bar-label">${d.toLocaleDateString('en-IN', { weekday: 'short' })}</div></div>`;
  }).join('')}</div>`;
}
function renderRecentInvoices() {
  const el = $('recent-invoices');
  if (!el) return;
  const recent = invoices.slice(0, 5);
  if (!recent.length) { el.innerHTML = `<div class="empty-state" style="padding:20px;"><p>No invoices yet.</p></div>`; return; }
  el.innerHTML = recent.map(i => `
    <div class="mini-invoice-row">
      <div><div class="mi-id">#${i.id}</div><div class="mi-sub">${escapeHtml(i.customerName)} · ${fmtDate(i.date)}</div></div>
      <div class="mi-amt">${fmtMoney(i.total)}</div>
    </div>`).join('');
}

/* =========================================
   RENDER — ANALYTICS (new tab)
   All figures here are computed live from the same
   `invoices` and `inventory` arrays used everywhere else —
   nothing extra is stored just for this screen.
   ========================================= */
function renderAnalytics() {
  const now = new Date();

  // --- revenue for today / this week / this month ---
  const startOfWeek = new Date(now); startOfWeek.setDate(now.getDate() - 6); startOfWeek.setHours(0, 0, 0, 0);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  let revToday = 0, revWeek = 0, revMonth = 0;
  invoices.forEach(inv => {
    const d = new Date(inv.date);
    if (isNaN(d)) return;
    if (isSameDay(d, now)) revToday += inv.total;
    if (d >= startOfWeek) revWeek += inv.total;
    if (d >= startOfMonth) revMonth += inv.total;
  });
  $('an-rev-today').innerText = fmtMoneyShort(revToday);
  $('an-rev-week').innerText = fmtMoneyShort(revWeek);
  $('an-rev-month').innerText = fmtMoneyShort(revMonth);

  renderSalesTrend(now, 'an-trend-chart');

  // --- top selling medicines by revenue ---
  const revByItem = {};
  invoices.forEach(inv => (inv.items || []).forEach(it => {
    revByItem[it.name] = (revByItem[it.name] || 0) + (it.price * it.qty);
  }));
  const topItems = Object.entries(revByItem).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const topEl = $('an-top-items');
  if (!topItems.length) {
    topEl.innerHTML = `<div class="empty-state" style="padding:10px;"><p>No sales yet.</p></div>`;
  } else {
    const topMax = topItems[0][1] || 1;
    topEl.innerHTML = topItems.map(([name, amt], idx) => `
      <div class="bar-list-row">
        <div class="bar-list-rank">${idx + 1}</div>
        <div class="bar-list-body">
          <div class="bar-list-top"><span>${escapeHtml(name)}</span><span>${fmtMoney(amt)}</span></div>
          <div class="bar-list-track"><div class="bar-list-fill" style="width:${Math.max((amt / topMax) * 100, 4)}%;"></div></div>
        </div>
      </div>`).join('');
  }

  // --- payment method split ---
  const byPay = { Cash: 0, Card: 0, UPI: 0 };
  invoices.forEach(inv => { const m = inv.paymentMethod || 'Cash'; byPay[m] = (byPay[m] || 0) + inv.total; });
  const payTotal = Object.values(byPay).reduce((s, v) => s + v, 0);
  const payColors = { Cash: 'var(--green)', Card: 'var(--blue)', UPI: 'var(--amber)' };
  const splitBar = $('an-split-bar'), splitLegend = $('an-split-legend');
  if (payTotal <= 0) {
    splitBar.innerHTML = '';
    splitLegend.innerHTML = `<div class="hint">No sales yet.</div>`;
  } else {
    splitBar.innerHTML = Object.entries(byPay).filter(([, v]) => v > 0).map(([m, v]) =>
      `<span style="width:${(v / payTotal) * 100}%;background:${payColors[m]};"></span>`).join('');
    splitLegend.innerHTML = Object.entries(byPay).map(([m, v]) => `
      <div class="split-legend-item"><span class="split-legend-dot" style="background:${payColors[m]};"></span>${m} — ${Math.round((v / payTotal) * 100) || 0}%</div>
    `).join('');
  }

  // --- inventory health ---
  $('an-health-total').innerText = inventory.length;
  $('an-health-low').innerText = inventory.filter(i => i.qty > 0 && i.qty <= settings.lowStockThreshold).length;
  $('an-health-expiring').innerText = inventory.filter(i => { const d = i.exp ? daysUntil(i.exp) : null; return d !== null && d >= 0 && d <= settings.expiryWarningDays; }).length;
  $('an-health-expired').innerText = inventory.filter(i => { const d = i.exp ? daysUntil(i.exp) : null; return d !== null && d < 0; }).length;
}

/* =========================================
   RENDER — everything else (cart, stock list, invoices list)
   ========================================= */
function renderUI() {
  const cartList = $('cart-list'), cartSum = $('cart-summary');
  $('cart-count').innerText = cart.length ? cart.reduce((s, c) => s + c.qty, 0) : '';
  if (cart.length) {
    cartList.innerHTML = cart.map(i => `
      <div class="card">
        <div class="card-col"><div class="card-title">${escapeHtml(i.name)}</div>
          <div class="card-sub">${i.mrp > i.price ? `<span class="mono" style="text-decoration:line-through;color:var(--muted-2);">${fmtMoney(i.mrp)}</span>` : ''}<span class="mono">${fmtMoney(i.price)}</span>${i.taxPct ? `<span class="badge" style="background:var(--green-soft);color:var(--green-dark);">${i.taxPct}% GST</span>` : ''}</div>
        </div>
        <div class="qty-stepper">
          <button class="btn-qty" onclick="updateCartQty('${i.barcode}', -1)">-</button>
          <div class="qty-input-inline">${i.qty}</div>
          <button class="btn-qty" onclick="updateCartQty('${i.barcode}', 1)">+</button>
          <button class="btn-qty btn-del" onclick="updateCartQty('${i.barcode}', -9999)">×</button>
        </div>
      </div>`).join('');
    const totals = computeCartTotals();
    $('sum-mrp').innerText = fmtMoney(totals.totalMRP);
    if (totals.savings > 0.004) { $('sum-savings-row').style.display = 'flex'; $('sum-savings').innerText = fmtMoney(totals.savings); }
    else $('sum-savings-row').style.display = 'none';
    $('sum-subtotal').innerText = fmtMoney(totals.subtotal);
    if (totals.tax > 0.004) { $('sum-tax-row').style.display = 'flex'; $('sum-tax-label').innerText = 'GST'; $('sum-tax').innerText = fmtMoney(totals.tax); }
    else $('sum-tax-row').style.display = 'none';
    if (totals.additionalDiscount > 0.004) { $('sum-adjdisc-row').style.display = 'flex'; $('sum-discount').innerText = '-' + fmtMoney(totals.additionalDiscount); }
    else $('sum-adjdisc-row').style.display = 'none';
    $('cart-total').innerText = fmtMoney(totals.total);
    cartSum.style.display = 'block';
  } else {
    cartList.innerHTML = `<div class="empty-state"><svg width="36" height="36" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5"/></svg><p>Cart is empty — scan an item to begin</p></div>`;
    cartSum.style.display = 'none';
  }

  const q = ($('stock-search') ? $('stock-search').value : '').trim().toLowerCase();
  let filtered = inventory.filter(i => !q || i.name.toLowerCase().includes(q) || i.barcode.toLowerCase().includes(q) || (i.batch || '').toLowerCase().includes(q));
  if (stockFilter === 'low') filtered = filtered.filter(i => i.qty > 0 && i.qty <= settings.lowStockThreshold);
  if (stockFilter === 'expiring') filtered = filtered.filter(i => { const d = i.exp ? daysUntil(i.exp) : null; return d !== null && d >= 0 && d <= settings.expiryWarningDays; });
  if (stockFilter === 'expired') filtered = filtered.filter(i => { const d = i.exp ? daysUntil(i.exp) : null; return d !== null && d < 0; });
  $('stock-list').innerHTML = filtered.length ? filtered.map(i => {
    const status = computeStockStatus(i);
    const disc = discPctOf(i);
    return `<div class="card clickable ${status.strip}" onclick="processBarcode('${i.barcode.replace(/'/g, "\\'")}', 'stock')">
      <div class="card-col"><div class="card-title">${escapeHtml(i.name)}</div>
        <div class="card-sub"><span class="badge">Batch: ${escapeHtml(i.batch || 'N/A')}</span><span class="badge">Exp: ${escapeHtml(i.exp || 'N/A')}</span><span class="badge ${status.cls}">${status.label}</span></div>
        <div class="card-sub">${i.mrp > i.price ? `<span class="mono" style="text-decoration:line-through;color:var(--muted-2);">${fmtMoney(i.mrp)}</span>` : ''}<span class="badge" style="background:var(--green-soft);color:var(--green-dark);">${i.taxPct || 0}% GST</span>${disc > 0 ? `<span class="badge badge-ok">${disc}% off</span>` : ''}</div>
      </div>
      <div class="card-col" style="align-items:flex-end;"><div class="price">${fmtMoney(i.price)}</div><div class="card-sub">Qty: ${i.qty}</div></div>
    </div>`;
  }).join('') : `<div class="empty-state"><svg width="36" height="36" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/></svg><p>${q || stockFilter !== 'all' ? 'No items match your search' : 'No inventory added yet — scan or add a medicine'}</p></div>`;

  const iq = ($('invoice-search') ? $('invoice-search').value : '').trim().toLowerCase();
  const filteredInv = invoices.filter(i => !iq || i.id.toLowerCase().includes(iq) || (i.customerName || '').toLowerCase().includes(iq) || (i.customerPhone || '').toLowerCase().includes(iq));
  $('invoice-list').innerHTML = filteredInv.length ? filteredInv.map(i => `
    <div class="card clickable" onclick="viewInvoice('${i.id}')">
      <div class="card-col"><div class="card-title">#${i.id}</div><div class="card-sub">${escapeHtml(i.customerName)} · ${fmtDate(i.date)}</div></div>
      <div class="price">${fmtMoney(i.total)}</div>
    </div>`).join('') : `<div class="empty-state"><svg width="36" height="36" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg><p>${iq ? 'No invoices match your search' : 'No invoices found'}</p></div>`;

  updateSyncIndicator();
  renderDashboard();
}

/* =========================================
   INIT
   ========================================= */
setAuthMode('login');
initAuth();
