// Atlas CRM - internal customer platform (demo). Single-file Node HTTP server,
// no dependencies. Employees across APAC / EMEA / Americas sign in and work.
// Localized in English / French / German. A subtle in-UI control toggles a
// region's sign-in outage for live demos.
//
// Outage model: breaking a region takes down its SIGN-IN / auth path. Account
// DATA keeps loading. New sign-ins fail one user at a time with clustered
// errors; failures accumulate and only escalate to "incident raised" after a
// threshold. Monitoring watches /api/health (503), tripping a GCP uptime check
// that opens a Major Incident in Atomicwork.
//
// Endpoints:
//   GET  /                        employee CRM UI (accounts + live sign-in feed)
//   GET  /control                 operator panel to break/restore regions
//   GET  /api/health              auth health (503 if any region down); ?region=APAC
//   GET  /api/accounts?region=    account data (stays available during an outage)
//   GET  /api/activity?region=    live sign-in feed; failures carry a stable `code`
//   POST /api/control/break       {region|"all"}  (needs x-control-token)
//   POST /api/control/restore     {region|"all"}
//
// State is in-memory; run a single instance (Cloud Run --min/max-instances 1).

const http = require("http");
const PORT = process.env.PORT || 8791;
const CONTROL_TOKEN = process.env.CONTROL_TOKEN || "atlas-demo-2026";
const FAIL_INTERVAL_MS = 7000;
const ESCALATE_AFTER = 3;

const REGIONS = {
  APAC: { label: "APAC", hub: "Singapore", users: 1840,
    accounts: [
      ["Meridian Logistics", "Singapore", "Enterprise", "Active", 420000],
      ["Sakura Robotics", "Tokyo", "Enterprise", "Renewal", 610000],
      ["Harbour Freight AU", "Sydney", "Mid-Market", "Active", 155000],
      ["Batik Retail Group", "Jakarta", "Mid-Market", "At risk", 98000],
      ["Kai Semiconductors", "Taipei", "Enterprise", "Active", 720000],
    ],
    staff: [
      ["Ananya Gupta", "Singapore"], ["Wei Chen", "Tokyo"], ["Priya Nair", "Bengaluru"],
      ["Hiroshi Tanaka", "Osaka"], ["Mei Lin", "Taipei"], ["Arjun Rao", "Sydney"], ["Sofia Reyes", "Manila"],
    ] },
  EMEA: { label: "EMEA", hub: "Paris", users: 2610,
    accounts: [
      ["Lumiere Mobility", "Paris", "Enterprise", "Active", 540000],
      ["Thameside Bank", "London", "Enterprise", "Renewal", 880000],
      ["Bavaria Autowerk", "Munich", "Enterprise", "Active", 1250000],
      ["Nordvik Energy", "Oslo", "Mid-Market", "Active", 210000],
      ["Iberia Fresh", "Madrid", "Mid-Market", "At risk", 74000],
    ],
    staff: [
      ["Lucas Martin", "Paris"], ["Emma Schmidt", "Munich"], ["Oliver Brown", "London"],
      ["Sofia Rossi", "Milan"], ["Nils Andersen", "Oslo"], ["Aisha Khan", "Dubai"],
    ] },
  AMER: { label: "Americas", hub: "New York", users: 2190,
    accounts: [
      ["Hudson Analytics", "New York", "Enterprise", "Active", 690000],
      ["Golden Gate Health", "San Francisco", "Enterprise", "Renewal", 930000],
      ["Prairie Foods", "Chicago", "Mid-Market", "Active", 168000],
      ["Andes Telecom", "Sao Paulo", "Enterprise", "At risk", 305000],
      ["Maple Freight", "Toronto", "Mid-Market", "Active", 142000],
    ],
    staff: [
      ["Michael Johnson", "New York"], ["Emily Davis", "San Francisco"], ["Carlos Silva", "Sao Paulo"],
      ["Jessica Wong", "Toronto"], ["David Miller", "Chicago"], ["Laura Gomez", "Mexico City"],
    ] },
};

// Stable error codes (client localizes them). Clustered around one root cause.
const SIGNIN_CODES = ["IDP_TIMEOUT", "SSO_EXCHANGE", "SESSION_STORE", "GATEWAY_503", "SAML_TIMEOUT", "ACCT_SVC", "MFA"];

const broken = new Set();
const brokenSince = {};

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function hhmmss(ts) {
  const d = new Date(ts), p = n => String(n).padStart(2, "0");
  return p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + ":" + p(d.getUTCSeconds()) + " UTC";
}
function healthPayload(region) {
  const keys = region ? [region] : Object.keys(REGIONS);
  const regions = {}; let ok = true;
  keys.forEach(k => { const up = REGIONS[k] && !broken.has(k); regions[k] = up ? "healthy" : "down"; if (!up) ok = false; });
  return { ok, regions, checked_at: new Date().toISOString() };
}
function activityPayload(region) {
  const r = REGIONS[region];
  if (!r) return { error: "unknown region" };
  const staff = r.staff, now = Date.now(), events = [];
  if (!broken.has(region)) {
    for (let i = 0; i < Math.min(6, staff.length); i++)
      events.push({ ts: now - (i * 11000 + 4000), user: staff[i][0], city: staff[i][1], status: "ok" });
    return { region, state: "healthy", failures: 0, escalate_after: ESCALATE_AFTER, escalated: false, events };
  }
  const since = brokenSince[region] || now;
  const steps = Math.floor((now - since) / FAIL_INTERVAL_MS) + 1;
  const fails = [];
  for (let i = 0; i < steps; i++) {
    const u = staff[i % staff.length];
    fails.push({ ts: since + i * FAIL_INTERVAL_MS, user: u[0], city: u[1], status: "failed",
      code: SIGNIN_CODES[i % SIGNIN_CODES.length], retry: i >= staff.length });
  }
  fails.reverse();
  return { region, state: "degraded", failures: fails.length, escalate_after: ESCALATE_AFTER,
    escalated: fails.length >= ESCALATE_AFTER, since, events: fails.slice(0, 12) };
}

// ── UI shell ──────────────────────────────────────────────────────────────────
function page(body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Atlas CRM</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#f6f7f9;--surface:#fff;--border:#e5e8ec;--text:#1c2430;--muted:#6b7686;
--accent:#3b6ef0;--accent-bg:#eaf0fe;--green:#12885a;--green-bg:#e2f4ec;
--red:#d23f3f;--red-bg:#fbe9e9;--amber:#c07d0a;--amber-bg:#fbf1dc;
--font:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
body{font-family:var(--font);background:var(--bg);color:var(--text);font-size:14px;line-height:1.45}
.top{background:var(--surface);border-bottom:1px solid var(--border);padding:12px 22px;display:flex;align-items:center;gap:14px}
.top .logo{display:flex;align-items:center;gap:9px;font-weight:700;font-size:15px}
.top .logo .dot{width:9px;height:9px;border-radius:50%;background:var(--accent)}
.top .sub{color:var(--muted);font-size:12px}
.top .right{margin-left:auto;display:flex;align-items:center;gap:14px}
.top .who{color:var(--muted);font-size:12px}
.top select.lang{font-family:inherit;font-size:12px;padding:4px 8px;border:1px solid var(--border);border-radius:7px;background:var(--surface);color:var(--text)}
.wrap{max-width:1120px;margin:0 auto;padding:22px}
.tabs{display:flex;gap:6px;margin-bottom:18px}
.tabs a{padding:6px 14px;border:1px solid var(--border);border-radius:7px;background:var(--surface);color:var(--muted);font-weight:600;font-size:13px;text-decoration:none}
.tabs a.on{background:var(--accent);color:#fff;border-color:var(--accent)}
.statusbar{display:flex;align-items:center;gap:10px;border-radius:9px;padding:10px 14px;margin-bottom:16px;font-size:13px;font-weight:500;border:1px solid var(--border);background:var(--surface)}
.statusbar .sdot{width:9px;height:9px;border-radius:50%;flex-shrink:0}
.statusbar.ok .sdot{background:var(--green)} .statusbar.ok{color:var(--green)}
.statusbar.warn{background:var(--amber-bg);border-color:var(--amber);color:var(--amber)} .statusbar.warn .sdot{background:var(--amber)}
.statusbar.crit{background:var(--red-bg);border-color:var(--red);color:var(--red)} .statusbar.crit .sdot{background:var(--red)}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px}
.kpi{background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:14px 16px}
.kpi .v{font-size:22px;font-weight:800;letter-spacing:-.4px}
.kpi .l{font-size:12px;color:var(--muted);margin-top:2px}
.grid{display:grid;grid-template-columns:1.15fr 1fr;gap:16px;align-items:start}
.card{background:var(--surface);border:1px solid var(--border);border-radius:9px;overflow:hidden}
.card h3{font-size:13px;font-weight:700;padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px}
.card h3 .rt{margin-left:auto;font-weight:500;color:var(--muted);font-size:11px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:9px 16px;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--muted);background:var(--bg);border-bottom:1px solid var(--border)}
td{padding:9px 16px;border-bottom:1px solid var(--border)}
tr:last-child td{border-bottom:none}
.pill{display:inline-block;padding:2px 9px;border-radius:11px;font-size:11px;font-weight:600}
.pill.Active{background:var(--green-bg);color:var(--green)}
.pill.Renewal{background:var(--accent-bg);color:var(--accent)}
.pill.risk{background:var(--amber-bg);color:var(--amber)}
.regsel{margin-left:auto;display:flex;gap:6px;align-items:center}
.regsel select{font-family:inherit;font-size:13px;padding:5px 10px;border:1px solid var(--border);border-radius:7px;background:var(--surface)}
.feed{max-height:360px;overflow-y:auto}
.evt{display:flex;align-items:flex-start;gap:10px;padding:9px 16px;border-bottom:1px solid var(--border)}
.evt:last-child{border-bottom:none}
.av{width:26px;height:26px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff;background:var(--accent)}
.evt.fail .av{background:var(--red)}
.evt .who2{font-weight:600}
.evt .meta{font-size:11px;color:var(--muted)}
.evt .detail{font-size:12px;margin-top:2px}
.evt.fail .detail{color:var(--red)}
.evt .st{margin-left:auto;font-size:11px;font-weight:600;white-space:nowrap}
.evt.ok .st{color:var(--green)} .evt.fail .st{color:var(--red)}
.controls{display:flex;flex-direction:column;gap:10px}
.crow{background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:14px 16px;display:flex;align-items:center;gap:14px}
.crow .rl{font-weight:700;min-width:120px}
.crow .stt{font-size:12px;font-weight:600;padding:2px 10px;border-radius:11px}
.crow .stt.up{background:var(--green-bg);color:var(--green)}
.crow .stt.dn{background:var(--red-bg);color:var(--red)}
.crow .sp{margin-left:auto;display:flex;gap:8px}
button{font-family:inherit;font-size:13px;font-weight:600;padding:7px 14px;border-radius:7px;border:1px solid var(--border);background:var(--surface);cursor:pointer}
button.break{border-color:var(--red);color:var(--red)}
button.fix{border-color:var(--green);color:var(--green)}
.hint{color:var(--muted);font-size:12px;margin-top:8px}
/* subtle in-UI demo control */
#democtl{position:fixed;right:16px;bottom:16px;width:34px;height:34px;border-radius:50%;background:var(--surface);
border:1px solid var(--border);color:var(--muted);display:flex;align-items:center;justify-content:center;cursor:pointer;
box-shadow:0 1px 4px rgba(0,0,0,.10);opacity:.5;transition:opacity .15s,border-color .15s,color .15s;user-select:none}
#democtl:hover{opacity:1}
#democtl.down{border-color:var(--red);color:var(--red);opacity:.9}
#democtl svg{width:16px;height:16px}
@media(max-width:820px){.grid{grid-template-columns:1fr}.kpis{grid-template-columns:repeat(2,1fr)}}
</style></head><body>
<div class="top"><div class="logo"><span class="dot"></span>Atlas CRM</div>
<span class="sub" id="appsub">Internal Customer Platform</span>
<span class="right"><span class="who" id="who">Signed in: Priya Nair . Sales Ops</span>
<select class="lang" id="lang" onchange="setLang(this.value)"><option value="en">English</option><option value="fr">Français</option><option value="de">Deutsch</option></select></span></div>
<div class="wrap">${body}</div></body></html>`;
}

const I18N_JSON = JSON.stringify({
  en: {
    appsub: "Internal Customer Platform", who: "Signed in: Priya Nair · Sales Ops",
    tabWorkspace: "Workspace", tabStatus: "Service status", region: "Region", americas: "Americas",
    kpiAccounts: "Accounts in region", kpiArr: "Total ARR", kpiUsers: "Active users", kpiRisk: "At-risk accounts",
    accounts: "Accounts", colAccount: "Account", colCity: "City", colSegment: "Segment", colStatus: "Status", colArr: "ARR",
    Active: "Active", Renewal: "Renewal", "At risk": "At risk", Enterprise: "Enterprise", "Mid-Market": "Mid-Market",
    signin: "Sign-in activity", live: "live", success: "Success", failed: "Failed", signedIn: "Signed in",
    healthy: "All sign-ins healthy in {r}",
    degraded: "{n} user(s) reporting sign-in errors in {r}…",
    escalated: "Elevated sign-in failures in {r} — {n} users affected. Incident raised, IT investigating.",
    retry: " (retry)", demoToggle: "Toggle region sign-in (demo)",
    IDP_TIMEOUT: "Sign-in failed: identity service timed out (HTTP 504)",
    SSO_EXCHANGE: "Sign-in failed: SSO token exchange error (HTTP 502)",
    SESSION_STORE: "Sign-in failed: session store unreachable (connection reset)",
    GATEWAY_503: "Sign-in failed: auth gateway returned 503 upstream",
    SAML_TIMEOUT: "Sign-in failed: SAML assertion validation timed out",
    ACCT_SVC: "Sign-in failed: could not reach account service (ETIMEDOUT)",
    MFA: "Sign-in failed: MFA challenge could not be delivered",
  },
  fr: {
    appsub: "Plateforme client interne", who: "Connecté : Priya Nair · Ventes",
    tabWorkspace: "Espace de travail", tabStatus: "État du service", region: "Région", americas: "Amériques",
    kpiAccounts: "Comptes de la région", kpiArr: "ARR total", kpiUsers: "Utilisateurs actifs", kpiRisk: "Comptes à risque",
    accounts: "Comptes", colAccount: "Compte", colCity: "Ville", colSegment: "Segment", colStatus: "Statut", colArr: "ARR",
    Active: "Actif", Renewal: "Renouvellement", "At risk": "À risque", Enterprise: "Grand compte", "Mid-Market": "Marché intermédiaire",
    signin: "Activité de connexion", live: "en direct", success: "Réussi", failed: "Échec", signedIn: "Connecté",
    healthy: "Toutes les connexions sont opérationnelles dans {r}",
    degraded: "{n} utilisateur(s) signalent des erreurs de connexion dans {r}…",
    escalated: "Nombre élevé d'échecs de connexion dans {r} — {n} utilisateurs concernés. Incident ouvert, l'informatique enquête.",
    retry: " (nouvelle tentative)", demoToggle: "Basculer la connexion de la région (démo)",
    IDP_TIMEOUT: "Échec de connexion : délai dépassé du service d'identité (HTTP 504)",
    SSO_EXCHANGE: "Échec de connexion : erreur d'échange de jeton SSO (HTTP 502)",
    SESSION_STORE: "Échec de connexion : magasin de sessions injoignable (connexion réinitialisée)",
    GATEWAY_503: "Échec de connexion : la passerelle d'authentification a renvoyé 503 en amont",
    SAML_TIMEOUT: "Échec de connexion : délai dépassé de validation de l'assertion SAML",
    ACCT_SVC: "Échec de connexion : impossible de joindre le service de comptes (ETIMEDOUT)",
    MFA: "Échec de connexion : le défi MFA n'a pas pu être délivré",
  },
  de: {
    appsub: "Interne Kundenplattform", who: "Angemeldet: Priya Nair · Vertrieb",
    tabWorkspace: "Arbeitsbereich", tabStatus: "Dienststatus", region: "Region", americas: "Amerika",
    kpiAccounts: "Konten in der Region", kpiArr: "Gesamt-ARR", kpiUsers: "Aktive Nutzer", kpiRisk: "Gefährdete Konten",
    accounts: "Konten", colAccount: "Konto", colCity: "Stadt", colSegment: "Segment", colStatus: "Status", colArr: "ARR",
    Active: "Aktiv", Renewal: "Verlängerung", "At risk": "Gefährdet", Enterprise: "Großkunde", "Mid-Market": "Mittelstand",
    signin: "Anmeldeaktivität", live: "live", success: "Erfolgreich", failed: "Fehlgeschlagen", signedIn: "Angemeldet",
    healthy: "Alle Anmeldungen funktionieren in {r}",
    degraded: "{n} Nutzer melden Anmeldefehler in {r}…",
    escalated: "Erhöhte Anmeldefehler in {r} — {n} Nutzer betroffen. Vorfall gemeldet, IT untersucht.",
    retry: " (Wiederholung)", demoToggle: "Regions-Anmeldung umschalten (Demo)",
    IDP_TIMEOUT: "Anmeldung fehlgeschlagen: Zeitüberschreitung des Identitätsdiensts (HTTP 504)",
    SSO_EXCHANGE: "Anmeldung fehlgeschlagen: SSO-Token-Austauschfehler (HTTP 502)",
    SESSION_STORE: "Anmeldung fehlgeschlagen: Sitzungsspeicher nicht erreichbar (Verbindung zurückgesetzt)",
    GATEWAY_503: "Anmeldung fehlgeschlagen: Auth-Gateway lieferte 503 vom Upstream",
    SAML_TIMEOUT: "Anmeldung fehlgeschlagen: Zeitüberschreitung bei der SAML-Assertion-Validierung",
    ACCT_SVC: "Anmeldung fehlgeschlagen: Kontodienst nicht erreichbar (ETIMEDOUT)",
    MFA: "Anmeldung fehlgeschlagen: MFA-Anfrage konnte nicht zugestellt werden",
  },
});

function crmPage() {
  const body = `
<div class="tabs"><a class="on" href="/" id="tab-ws">Workspace</a><a href="/control" id="tab-st">Service status</a></div>
<div class="statusbar ok" id="statusbar"><span class="sdot"></span><span id="statustext">…</span>
  <span class="regsel" id="regwrap"><span id="reglabel">Region</span>
    <select id="reg" onchange="switchRegion()">
      <option value="APAC">APAC</option><option value="EMEA">EMEA</option><option value="AMER">Americas</option>
    </select></span></div>
<div class="kpis">
  <div class="kpi"><div class="v" id="k-acc">--</div><div class="l" id="l-acc"></div></div>
  <div class="kpi"><div class="v" id="k-arr">--</div><div class="l" id="l-arr"></div></div>
  <div class="kpi"><div class="v" id="k-usr">--</div><div class="l" id="l-usr"></div></div>
  <div class="kpi"><div class="v" id="k-risk">--</div><div class="l" id="l-risk"></div></div>
</div>
<div class="grid">
  <div class="card"><h3 id="h-accounts">Accounts</h3><div id="tbl"></div></div>
  <div class="card"><h3 id="h-signin">Sign-in activity <span class="rt" id="feedrt">live</span></h3><div class="feed" id="feed"></div></div>
</div>
<div id="democtl" title="demo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v9"/><path d="M6.3 7A8 8 0 1 0 18 7"/></svg></div>
<script>
var I18N=${I18N_JSON};
var lang=(localStorage.getItem('atlas_lang')||'en'); if(!I18N[lang])lang='en';
var TOKEN='${CONTROL_TOKEN}';
var last={state:'healthy'};
function t(k,vars){var s=(I18N[lang]&&I18N[lang][k])||I18N.en[k]||k; if(vars)Object.keys(vars).forEach(function(v){s=s.replace('{'+v+'}',vars[v]);}); return s;}
function reg(){return document.getElementById('reg').value;}
function initials(n){return n.split(' ').map(function(w){return w[0]}).slice(0,2).join('');}

function applyStatic(){
  document.getElementById('lang').value=lang;
  document.getElementById('appsub').textContent=t('appsub');
  document.getElementById('who').textContent=t('who');
  document.getElementById('tab-ws').textContent=t('tabWorkspace');
  document.getElementById('tab-st').textContent=t('tabStatus');
  document.getElementById('reglabel').textContent=t('region');
  document.querySelector('#reg option[value="AMER"]').textContent=t('americas');
  document.getElementById('l-acc').textContent=t('kpiAccounts');
  document.getElementById('l-arr').textContent=t('kpiArr');
  document.getElementById('l-usr').textContent=t('kpiUsers');
  document.getElementById('l-risk').textContent=t('kpiRisk');
  document.getElementById('h-accounts').textContent=t('accounts');
  document.getElementById('h-signin').innerHTML=t('signin')+' <span class="rt">'+t('live')+'</span>';
  document.getElementById('democtl').title=t('demoToggle');
  document.documentElement.lang=lang;
}
function setLang(v){lang=v;localStorage.setItem('atlas_lang',v);applyStatic();loadAccounts();loadActivity();}

async function loadAccounts(){
  var tbl=document.getElementById('tbl');
  try{
    var r=await fetch('/api/accounts?region='+reg(),{cache:'no-store'}); var d=await r.json();
    document.getElementById('k-acc').textContent=d.accounts.length;
    document.getElementById('k-arr').textContent='$'+d.arr.toLocaleString('en-US');
    document.getElementById('k-usr').textContent=d.users.toLocaleString('en-US');
    document.getElementById('k-risk').textContent=d.accounts.filter(function(a){return a[3]==='At risk'}).length;
    var head='<tr><th>'+t('colAccount')+'</th><th>'+t('colCity')+'</th><th>'+t('colSegment')+'</th><th>'+t('colStatus')+'</th><th style="text-align:right">'+t('colArr')+'</th></tr>';
    tbl.innerHTML='<table><thead>'+head+'</thead><tbody>'+d.accounts.map(function(a){
      var c=a[3]==='At risk'?'risk':a[3];
      return '<tr><td><strong>'+a[0]+'</strong></td><td>'+a[1]+'</td><td>'+t(a[2])+'</td><td><span class="pill '+c+'">'+t(a[3])+'</span></td><td style="text-align:right">$'+a[4].toLocaleString('en-US')+'</td></tr>';
    }).join('')+'</tbody></table>';
  }catch(e){}
}
async function loadActivity(){
  var bar=document.getElementById('statusbar'),txt=document.getElementById('statustext'),feed=document.getElementById('feed');
  try{
    var r=await fetch('/api/activity?region='+reg(),{cache:'no-store'}); var d=await r.json(); last=d;
    if(d.state==='healthy'){bar.className='statusbar ok';txt.textContent=t('healthy',{r:reg()});}
    else if(d.escalated){bar.className='statusbar crit';txt.textContent=t('escalated',{r:reg(),n:d.failures});}
    else{bar.className='statusbar warn';txt.textContent=t('degraded',{r:reg(),n:d.failures});}
    feed.innerHTML=d.events.map(function(e){
      var cls=e.status==='ok'?'ok':'fail', st=e.status==='ok'?t('success'):t('failed');
      var detail=e.status==='ok'?t('signedIn'):(t(e.code)+(e.retry?t('retry'):''));
      return '<div class="evt '+cls+'"><div class="av">'+initials(e.user)+'</div>'+
        '<div><div class="who2">'+e.user+'</div><div class="meta">'+e.city+' · '+e.ts_label+'</div>'+
        '<div class="detail">'+detail+'</div></div><div class="st">'+st+'</div></div>';
    }).join('');
    var ctl=document.getElementById('democtl'); ctl.className=(d.state==='healthy')?'':'down';
  }catch(e){}
}
async function toggleRegion(){
  var op=(last.state==='healthy')?'break':'restore';
  await fetch('/api/control/'+op,{method:'POST',headers:{'Content-Type':'application/json','x-control-token':TOKEN},body:JSON.stringify({region:reg()})});
  loadActivity();
}
document.getElementById('democtl').addEventListener('click',toggleRegion);
function switchRegion(){loadAccounts();loadActivity();}
applyStatic();loadAccounts();loadActivity();
setInterval(loadActivity,4000);setInterval(loadAccounts,20000);
</script>`;
  return page(body);
}

function controlPage() {
  const rows = Object.keys(REGIONS).map(k => {
    const up = !broken.has(k);
    return `<div class="crow"><span class="rl">${REGIONS[k].label}</span>
      <span class="stt ${up ? "up" : "dn"}" id="st-${k}">${up ? "Sign-in healthy" : "Sign-in down"}</span>
      <span class="sp"><button class="break" onclick="act('break','${k}')">Simulate outage</button>
      <button class="fix" onclick="act('restore','${k}')">Restore</button></span></div>`;
  }).join("");
  const body = `
<div class="tabs"><a href="/">Workspace</a><a class="on" href="/control">Service status</a></div>
<div class="card" style="margin-bottom:16px"><h3>Region sign-in health (what monitoring sees)</h3>
  <div style="padding:14px 16px" id="hz">checking...</div></div>
<h3 style="font-size:13px;margin-bottom:10px">Operator controls</h3>
<div class="controls">${rows}
  <div class="crow"><span class="rl">All regions</span><span class="sp" style="margin-left:auto;display:flex;gap:8px">
    <button class="break" onclick="act('break','all')">Simulate all</button>
    <button class="fix" onclick="act('restore','all')">Restore all</button></span></div></div>
<div class="hint">"Simulate outage" takes down a region's sign-in path: new logins fail (watch the Workspace tab), /api/health flips to 503, and a GCP uptime check opens a Major Incident in Atomicwork.</div>
<script>
var TOKEN='${CONTROL_TOKEN}';
async function refresh(){
  var r=await fetch('/api/health?all=1',{cache:'no-store'}); var d=await r.json();
  document.getElementById('hz').innerHTML=Object.keys(d.regions).map(function(k){var up=d.regions[k]==='healthy';
    return '<span style="margin-right:16px"><strong>'+k+'</strong>: <span style="color:'+(up?'var(--green)':'var(--red)')+'">'+d.regions[k]+'</span></span>';}).join('')+
    ' <span style="color:var(--muted);font-size:12px">(overall '+(d.ok?'200':'503')+')</span>';
  Object.keys(d.regions).forEach(function(k){var el=document.getElementById('st-'+k);if(el){var up=d.regions[k]==='healthy';el.textContent=up?'Sign-in healthy':'Sign-in down';el.className='stt '+(up?'up':'dn');}});
}
async function act(op,region){await fetch('/api/control/'+op,{method:'POST',headers:{'Content-Type':'application/json','x-control-token':TOKEN},body:JSON.stringify({region:region})});refresh();}
refresh();setInterval(refresh,3000);
</script>`;
  return page(body);
}

// ── Server ─────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x"), path = u.pathname;
  if (path === "/") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end(crmPage()); }
  if (path === "/control") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end(controlPage()); }

  if (path === "/api/health" || path === "/healthz") {
    const region = u.searchParams.get("region");
    if (region && !REGIONS[region]) return json(res, 404, { ok: false, error: "unknown region" });
    const p = healthPayload(region);
    return json(res, p.ok ? 200 : 503, p);
  }
  if (path === "/api/accounts") {
    const region = u.searchParams.get("region") || "APAC", r = REGIONS[region];
    if (!r) return json(res, 404, { error: "unknown region" });
    const arr = r.accounts.reduce((a, x) => a + x[4], 0);
    return json(res, 200, { region, hub: r.hub, users: r.users, arr, accounts: r.accounts });
  }
  if (path === "/api/activity") {
    const region = u.searchParams.get("region") || "APAC", p = activityPayload(region);
    if (p.error) return json(res, 404, p);
    p.events = p.events.map(e => Object.assign(e, { ts_label: hhmmss(e.ts) }));
    return json(res, 200, p);
  }
  if (path === "/api/control/break" || path === "/api/control/restore") {
    if (req.method !== "POST") return json(res, 405, { error: "POST only" });
    if ((req.headers["x-control-token"] || u.searchParams.get("token")) !== CONTROL_TOKEN)
      return json(res, 401, { error: "bad control token" });
    let raw = "";
    req.on("data", c => raw += c);
    req.on("end", () => {
      let region = "all";
      try { region = JSON.parse(raw || "{}").region || u.searchParams.get("region") || "all"; }
      catch (e) { region = u.searchParams.get("region") || "all"; }
      const targets = region === "all" ? Object.keys(REGIONS) : [region];
      targets.forEach(k => {
        if (!REGIONS[k]) return;
        if (path.endsWith("break")) { if (!broken.has(k)) { broken.add(k); brokenSince[k] = Date.now(); } }
        else { broken.delete(k); delete brokenSince[k]; }
      });
      return json(res, 200, { ok: true, action: path.split("/").pop(), broken: [...broken] });
    });
    return;
  }
  json(res, 404, { error: "not found" });
});
server.listen(PORT, () => console.log("Atlas CRM on :" + PORT));
