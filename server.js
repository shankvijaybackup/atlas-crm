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
//   GET  /                        employee sign-in page; on success a per-user
//                                 dashboard (that user's own region accounts only)
//   POST /api/login               {email}; admin -> {redirect:"/control"}; a general
//                                 user gets 503 + localized error when their region is down
//   GET  /control                 operator console: region health, live sign-in feed, break/restore
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
// One-click Major Incident: when "Simulate all" breaks every region, the app
// files the Atlas CRM pattern incidents to Atomicwork (IT Ops) itself.
const AW_API_URL = process.env.AW_API_URL || "https://atomicgws.atomicwork.com/api/v1/requests/create";
const AW_API_KEY = process.env.AW_API_KEY || "";          // set via Cloud Run env, never committed
const AW_WORKSPACE_ID = Number(process.env.AW_WORKSPACE_ID || 2387);
const AW_GROUP = Number(process.env.AW_GROUP || 7584);    // 7584 = IT Ops
const FILE_INCIDENTS = process.env.FILE_INCIDENTS !== "0"; // default on when AW_API_KEY is present
let incidentsFired = false;
// Scenario 2: data-layer outage (customer records / accounts fail to load).
let dataOutage = false;
let dataSince = 0;
let dataIncidentsFired = false;
const FAIL_INTERVAL_MS = 7000;
const ESCALATE_AFTER = 3;
// Ledger reconciliation gate: don't report the data layer healthy until each
// region's account ledger has fully loaded (guards against a partial read on
// cold start returning a truncated account list).
const MIN_LEDGER_ACCOUNTS = 50;

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

// Demo end users (general users). luke@ and lisa@ are the ones used in the demo.
// Any other non-admin email is treated as a generic EMEA user so a live sign-in
// always resolves. Admins (vijay@ / anything @atomicwork.com / admin*) are routed
// to the operator console instead of the CRM, so a general user never sees other
// users' information or the operator controls.
const USERS = {
  "luke@valeo.com": { name: "Luke Wilson", region: "EMEA", city: "London", code: "SESSION_STORE" },
  "lisa@valeo.com": { name: "Lisa Bernard", region: "EMEA", city: "Paris", code: "SSO_EXCHANGE" },
};
function isAdminEmail(e) { return /(^|\.)vijay|@atomicwork\.com$|^admin/.test(e); }
function resolveUser(email) {
  if (USERS[email]) return Object.assign({ email }, USERS[email]);
  const local = (email.split("@")[0] || "user").replace(/[._]+/g, " ").trim();
  const name = local.split(" ").map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(" ") || "User";
  return { email, name, region: "EMEA", city: "", code: "IDP_TIMEOUT" };
}

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function hhmmss(ts) {
  const d = new Date(ts), p = n => String(n).padStart(2, "0");
  return p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + ":" + p(d.getUTCSeconds()) + " UTC";
}
function ledgerReconciled(r) {
  return r.accounts.length >= MIN_LEDGER_ACCOUNTS;
}
function healthPayload(region) {
  const keys = region ? [region] : Object.keys(REGIONS);
  const regions = {}; let ok = true;
  keys.forEach(k => { const up = REGIONS[k] && !broken.has(k); regions[k] = up ? "healthy" : "down"; if (!up) ok = false; });
  const ledgerOk = Object.values(REGIONS).every(ledgerReconciled);
  if (dataOutage || !ledgerOk) ok = false;
  return { ok, regions, data_layer: (dataOutage || !ledgerOk) ? "down" : "healthy", checked_at: new Date().toISOString() };
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
function page(body, opts) {
  opts = opts || {};
  const who = ("who" in opts) ? opts.who : "Signed in: Priya Nair · Sales Ops";
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
<span class="right"><span class="who" id="who">${who}</span>
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
    signInTitle: "Sign in to Atlas CRM", emailLabel: "Work email", passwordLabel: "Password", signInBtn: "Sign in", signingIn: "Signing in…", demoHint: "Use your work email to sign in.", needEmail: "Enter your work email.", welcome: "Welcome back, {name}", signOut: "Sign out", yourAccounts: "Your accounts",
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
    signInTitle: "Se connecter à Atlas CRM", emailLabel: "E-mail professionnel", passwordLabel: "Mot de passe", signInBtn: "Se connecter", signingIn: "Connexion…", demoHint: "Utilisez votre e-mail professionnel pour vous connecter.", needEmail: "Saisissez votre e-mail professionnel.", welcome: "Bon retour, {name}", signOut: "Se déconnecter", yourAccounts: "Vos comptes",
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
    signInTitle: "Bei Atlas CRM anmelden", emailLabel: "Geschäftliche E-Mail", passwordLabel: "Passwort", signInBtn: "Anmelden", signingIn: "Anmeldung…", demoHint: "Melden Sie sich mit Ihrer geschäftlichen E-Mail an.", needEmail: "Geben Sie Ihre geschäftliche E-Mail ein.", welcome: "Willkommen zurück, {name}", signOut: "Abmelden", yourAccounts: "Ihre Konten",
    IDP_TIMEOUT: "Anmeldung fehlgeschlagen: Zeitüberschreitung des Identitätsdiensts (HTTP 504)",
    SSO_EXCHANGE: "Anmeldung fehlgeschlagen: SSO-Token-Austauschfehler (HTTP 502)",
    SESSION_STORE: "Anmeldung fehlgeschlagen: Sitzungsspeicher nicht erreichbar (Verbindung zurückgesetzt)",
    GATEWAY_503: "Anmeldung fehlgeschlagen: Auth-Gateway lieferte 503 vom Upstream",
    SAML_TIMEOUT: "Anmeldung fehlgeschlagen: Zeitüberschreitung bei der SAML-Assertion-Validierung",
    ACCT_SVC: "Anmeldung fehlgeschlagen: Kontodienst nicht erreichbar (ETIMEDOUT)",
    MFA: "Anmeldung fehlgeschlagen: MFA-Anfrage konnte nicht zugestellt werden",
  },
});

function loginPage() {
  const body = `
<style>
.auth{min-height:66vh;display:flex;align-items:center;justify-content:center;padding:20px 0}
.authcard{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:26px 24px;width:100%;max-width:380px;box-shadow:0 1px 3px rgba(0,0,0,.05)}
.authcard h2{font-size:18px;margin-bottom:3px}
.authcard .lead{color:var(--muted);font-size:13px;margin-bottom:18px}
.field{margin-bottom:12px}
.field label{display:block;font-size:12px;color:var(--muted);margin-bottom:5px}
.field input{width:100%;font-family:inherit;font-size:14px;padding:9px 11px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text)}
.field input:focus{outline:none;border-color:var(--accent)}
.btnprimary{width:100%;background:var(--accent);color:#fff;border-color:var(--accent);padding:10px;font-size:14px;margin-top:4px}
.btnprimary:disabled{opacity:.6;cursor:default}
.autherr{display:none;background:var(--red-bg);border:1px solid var(--red);color:var(--red);border-radius:8px;padding:10px 12px;font-size:13px;margin-bottom:14px;line-height:1.4}
.autherr.show{display:block}
.authhint{color:var(--muted);font-size:12px;margin-top:14px;text-align:center}
.dashtop{display:flex;align-items:center;justify-content:space-between;background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:12px 16px;margin-bottom:16px}
.dashtop .dw{display:flex;align-items:center;gap:9px;font-weight:600}
.dashtop .dw .sdot{width:9px;height:9px;border-radius:50%;background:var(--green)}
</style>
<div class="auth" id="authview">
  <form class="authcard" id="loginform" onsubmit="return doLogin(event)">
    <h2 id="a-title">Sign in to Atlas CRM</h2>
    <div class="lead" id="a-lead">Internal Customer Platform</div>
    <div class="autherr" id="a-err"></div>
    <div class="field"><label id="a-eml" for="email">Work email</label><input id="email" type="email" autocomplete="username" placeholder="name@valeo.com"></div>
    <div class="field"><label id="a-pwl" for="pwd">Password</label><input id="pwd" type="password" autocomplete="current-password" placeholder="••••••••"></div>
    <button class="btnprimary" id="a-btn" type="submit">Sign in</button>
    <div class="authhint" id="a-hint">Use your work email to sign in.</div>
  </form>
</div>
<div id="dashview" style="display:none">
  <div class="dashtop"><span class="dw"><span class="sdot"></span><span id="d-welcome"></span></span>
    <button id="d-signout" onclick="signOut()">Sign out</button></div>
  <div class="kpis">
    <div class="kpi"><div class="v" id="dk-acc">--</div><div class="l" id="dl-acc"></div></div>
    <div class="kpi"><div class="v" id="dk-arr">--</div><div class="l" id="dl-arr"></div></div>
    <div class="kpi"><div class="v" id="dk-usr">--</div><div class="l" id="dl-usr"></div></div>
    <div class="kpi"><div class="v" id="dk-risk">--</div><div class="l" id="dl-risk"></div></div>
  </div>
  <div class="card"><h3 id="d-acch">Your accounts</h3><div id="d-tbl"></div></div>
</div>
<script>
var I18N=${I18N_JSON};
var lang=(localStorage.getItem('atlas_lang')||'en'); if(!I18N[lang])lang='en';
var lastErrCode=null, currentUser=null;
function t(k,vars){var s=(I18N[lang]&&I18N[lang][k])||I18N.en[k]||k; if(vars)Object.keys(vars).forEach(function(v){s=s.replace('{'+v+'}',vars[v]);}); return s;}
function applyStatic(){
  document.getElementById('lang').value=lang;
  document.getElementById('appsub').textContent=t('appsub');
  document.getElementById('a-title').textContent=t('signInTitle');
  document.getElementById('a-lead').textContent=t('appsub');
  document.getElementById('a-eml').textContent=t('emailLabel');
  document.getElementById('a-pwl').textContent=t('passwordLabel');
  document.getElementById('a-btn').textContent=t('signInBtn');
  document.getElementById('a-hint').textContent=t('demoHint');
  document.getElementById('dl-acc').textContent=t('kpiAccounts');
  document.getElementById('dl-arr').textContent=t('kpiArr');
  document.getElementById('dl-usr').textContent=t('kpiUsers');
  document.getElementById('dl-risk').textContent=t('kpiRisk');
  document.getElementById('d-acch').textContent=t('yourAccounts');
  document.getElementById('d-signout').textContent=t('signOut');
  document.documentElement.lang=lang;
  if(lastErrCode) showErr(lastErrCode);
  if(currentUser){renderWelcome();loadAccounts();}
}
function setLang(v){lang=v;localStorage.setItem('atlas_lang',v);applyStatic();}
function showErr(code){lastErrCode=code;var e=document.getElementById('a-err');e.textContent=t(code);e.className='autherr show';}
function clearErr(){lastErrCode=null;var e=document.getElementById('a-err');e.className='autherr';e.textContent='';}
function renderWelcome(){if(currentUser)document.getElementById('d-welcome').textContent=t('welcome',{name:currentUser.name});}
async function doLogin(ev){
  ev.preventDefault();
  var email=document.getElementById('email').value.trim();
  if(!email){showErr('needEmail');return false;}
  var btn=document.getElementById('a-btn');btn.disabled=true;btn.textContent=t('signingIn');clearErr();
  try{
    var r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:email,lang:lang})});
    var d=await r.json();
    if(d.role==='admin'&&d.redirect){window.location.href=d.redirect;return false;}
    if(!d.ok){showErr(d.code||'GATEWAY_503');}
    else{clearErr();currentUser=d.user;showDash();}
  }catch(e){showErr('GATEWAY_503');}
  btn.disabled=false;btn.textContent=t('signInBtn');
  return false;
}
function showDash(){document.getElementById('authview').style.display='none';document.getElementById('dashview').style.display='block';renderWelcome();loadAccounts();}
function signOut(){currentUser=null;clearErr();document.getElementById('dashview').style.display='none';document.getElementById('authview').style.display='flex';document.getElementById('email').value='';document.getElementById('pwd').value='';}
async function loadAccounts(){
  if(!currentUser)return;
  try{
    var r=await fetch('/api/accounts?region='+currentUser.region,{cache:'no-store'});var d=await r.json();
    if(!d.accounts)return;
    document.getElementById('dk-acc').textContent=d.accounts.length;
    document.getElementById('dk-arr').textContent='$'+d.arr.toLocaleString('en-US');
    document.getElementById('dk-usr').textContent=d.users.toLocaleString('en-US');
    document.getElementById('dk-risk').textContent=d.accounts.filter(function(a){return a[3]==='At risk'}).length;
    var head='<tr><th>'+t('colAccount')+'</th><th>'+t('colCity')+'</th><th>'+t('colSegment')+'</th><th>'+t('colStatus')+'</th><th style="text-align:right">'+t('colArr')+'</th></tr>';
    document.getElementById('d-tbl').innerHTML='<table><thead>'+head+'</thead><tbody>'+d.accounts.map(function(a){
      var c=a[3]==='At risk'?'risk':a[3];
      return '<tr><td><strong>'+a[0]+'</strong></td><td>'+a[1]+'</td><td>'+t(a[2])+'</td><td><span class="pill '+c+'">'+t(a[3])+'</span></td><td style="text-align:right">$'+a[4].toLocaleString('en-US')+'</td></tr>';
    }).join('')+'</tbody></table>';
  }catch(e){}
}
applyStatic();
</script>`;
  return page(body, { who: "" });
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
<div class="tabs"><a href="/">Sign-in page</a><a class="on" href="/control">Operator console</a></div>
<div class="card" style="margin-bottom:16px"><h3>Region sign-in health (what monitoring sees)</h3>
  <div style="padding:14px 16px" id="hz">checking...</div></div>
<div class="card" style="margin-bottom:16px"><h3>Live sign-in attempts (all regions) <span class="rt">live</span></h3>
  <div class="feed" id="attempts" style="max-height:300px"></div></div>
<h3 style="font-size:13px;margin-bottom:10px">Operator controls</h3>
<div class="controls">${rows}
  <div class="crow"><span class="rl">All regions</span><span class="sp" style="margin-left:auto;display:flex;gap:8px">
    <button class="break" onclick="act('break','all')">Simulate all (sign-in)</button>
    <button class="fix" onclick="act('restore','all')">Restore all</button></span></div></div>
<h3 style="font-size:13px;margin:16px 0 10px">Scenario 2 - customer records / data outage</h3>
<div class="controls"><div class="crow"><span class="rl">Customer records (all regions)</span>
  <span class="sp" style="margin-left:auto;display:flex;gap:8px">
    <button class="break" onclick="act('break','all','data')">Simulate data outage</button>
    <button class="fix" onclick="act('restore','all','data')">Restore data</button></span></div></div>
<div class="hint">Two independent breakages, same platform. <strong>Simulate all (sign-in)</strong> takes down the auth path so logins fail, and files the sign-in incident set. <strong>Simulate data outage</strong> keeps sign-in working but makes customer records fail to load (/api/accounts returns 503), and files the data incident set. Either one flips /api/health to 503 and opens a Major Incident in Atomicwork.</div>
<script>
var TOKEN='${CONTROL_TOKEN}';
async function refresh(){
  var r=await fetch('/api/health?all=1',{cache:'no-store'}); var d=await r.json();
  document.getElementById('hz').innerHTML=Object.keys(d.regions).map(function(k){var up=d.regions[k]==='healthy';
    return '<span style="margin-right:16px"><strong>'+k+'</strong>: <span style="color:'+(up?'var(--green)':'var(--red)')+'">'+d.regions[k]+'</span></span>';}).join('')+
    ' <span style="color:var(--muted);font-size:12px">(overall '+(d.ok?'200':'503')+')</span>';
  Object.keys(d.regions).forEach(function(k){var el=document.getElementById('st-'+k);if(el){var up=d.regions[k]==='healthy';el.textContent=up?'Sign-in healthy':'Sign-in down';el.className='stt '+(up?'up':'dn');}});
}
async function act(op,region,scenario){await fetch('/api/control/'+op,{method:'POST',headers:{'Content-Type':'application/json','x-control-token':TOKEN},body:JSON.stringify({region:region,scenario:scenario||'signin'})});refresh();loadAttempts();}
function initials(n){return n.split(' ').map(function(w){return w[0]||''}).slice(0,2).join('');}
async function loadAttempts(){
  var regs=['APAC','EMEA','AMER'],all=[];
  for(var i=0;i<regs.length;i++){try{var r=await fetch('/api/activity?region='+regs[i],{cache:'no-store'});var d=await r.json();(d.events||[]).forEach(function(e){e._r=regs[i];all.push(e);});}catch(e){}}
  all.sort(function(a,b){return b.ts-a.ts;});
  var f=document.getElementById('attempts');
  if(!all.length){f.innerHTML='<div style="padding:14px 16px;color:var(--muted)">No recent attempts.</div>';return;}
  f.innerHTML=all.slice(0,16).map(function(e){var cls=e.status==='ok'?'ok':'fail';var st=e.status==='ok'?'Signed in':(e.code||'Failed');
    return '<div class="evt '+cls+'"><div class="av">'+initials(e.user)+'</div><div><div class="who2">'+e.user+'</div><div class="meta">'+e._r+' · '+e.city+' · '+e.ts_label+'</div></div><div class="st">'+st+'</div></div>';}).join('');
}
refresh();loadAttempts();setInterval(refresh,3000);setInterval(loadAttempts,4000);
</script>`;
  return page(body, { who: "Operator console" });
}

// ── Server ─────────────────────────────────────────────────────────────────────
// ---- One-click incident flood (fired on a full "Simulate all" outage) ----
const MON = 270141; // "Infra Monitoring" requester id (WS 2387)
const INCIDENTS = [
  { kind: "user", requester: 257979, subject: "Atlas CRM sign-in not working across the London team",
    description: "None of us on the London sales floor can sign in to Atlas CRM. Everyone gets 'Sign-in failed (SESSION_STORE)' after entering their password. It started about 20 minutes ago. We have tried different browsers and networks. This is blocking the whole team from customer accounts." },
  { kind: "user", requester: 257998, subject: "Connexion à Atlas CRM impossible - échec de l'authentification",
    description: "Je n'arrive plus à me connecter à Atlas CRM depuis ce matin. Après avoir saisi mon mot de passe, j'obtiens « Échec de la connexion (SSO_EXCHANGE) ». J'ai essayé deux navigateurs, sans succès. Plusieurs collègues du bureau de Paris ont le même problème." },
  { kind: "user", requester: 258006, subject: "Anmeldung bei Atlas CRM nicht möglich - Fehler beim Login",
    description: "Ich kann mich seit etwa einer halben Stunde nicht bei Atlas CRM anmelden. Nach der Passworteingabe erscheint „Anmeldung fehlgeschlagen (IDP_TIMEOUT)“. Neustart und ein anderer Browser haben nicht geholfen. Auch Kollegen im Münchner Büro sind betroffen." },
  { kind: "user", requester: 257983, subject: "Atlas CRM - impossible de se connecter (erreur SAML)",
    description: "Impossible d'accéder à Atlas CRM. La page de connexion tourne longtemps puis affiche « Échec de la connexion (SAML_TIMEOUT) ». J'ai vidé le cache et essayé en navigation privée, rien n'y fait. Deux personnes de l'équipe à Lyon signalent la même erreur." },
  { kind: "user", requester: 257995, subject: "Login bei Atlas CRM schlägt fehl - Kontodienst-Fehler",
    description: "Die Anmeldung bei Atlas CRM funktioniert nicht mehr. Nach Eingabe der Zugangsdaten kommt „Anmeldung fehlgeschlagen (ACCT_SVC)“. Das Zurücksetzen des Passworts war nicht möglich. Im Berliner Büro sind mehrere Kolleginnen und Kollegen ebenfalls ausgesperrt." },
  { kind: "user", requester: 258005, subject: "Atlas CRM login failing in Singapore - gateway error",
    description: "Atlas CRM throws 'Sign-in failed (GATEWAY_503)' whenever I try to log in from the Singapore office. Tried laptop and phone, same error each time. My team is locked out and cannot update opportunities." },
  { kind: "user", requester: 258013, subject: "Atlas CRM inaccessible depuis Marseille - échec de connexion",
    description: "Depuis le bureau de Marseille, impossible de me connecter à Atlas CRM. Le message affiché est « Échec de la connexion (IDP_TIMEOUT) ». Testé sur deux appareils, une collègue rencontre le même souci." },
  { kind: "user", requester: 257975, subject: "Anmeldung bei Atlas CRM schlägt fehl - Hamburg",
    description: "Aus dem Hamburger Büro komme ich nicht in Atlas CRM. Nach der Passworteingabe: „Anmeldung fehlgeschlagen (SSO_EXCHANGE)“. Ein anderer Browser und ein Neustart halfen nicht, Kollegen sind ebenfalls betroffen." },
  { kind: "user", requester: 257992, subject: "Can't sign in to Atlas CRM - stuck after MFA (Sydney)",
    description: "I approve the MFA prompt and Atlas CRM drops me back to the login screen with 'Sign-in failed (MFA)'. Three attempts, cleared cache, no luck. Colleagues in Sydney report the same thing." },
  { kind: "user", requester: 257991, subject: "Atlas CRM - connexion impossible depuis Genève",
    description: "Impossible d'accéder à Atlas CRM depuis Genève. Après le mot de passe, « Échec de la connexion (SESSION_STORE) », et la page recharge en boucle. Plusieurs personnes de l'équipe sont bloquées." },
  { kind: "user", requester: 258001, subject: "Atlas CRM - Anmeldung nicht möglich (Zürich)",
    description: "Beim Login zu Atlas CRM erscheint „Anmeldung fehlgeschlagen (GATEWAY_503)“. Das Problem besteht seit heute Morgen; im Zürcher Team sind mehrere Personen betroffen. Bitte dringend prüfen." },
  { kind: "user", requester: 258015, subject: "Atlas CRM sign-in broken - New York office",
    description: "None of us in the New York office can sign in to Atlas CRM. The login spins then shows 'Sign-in failed (SAML_TIMEOUT)'. It is blocking client prep this morning." },
  { kind: "user", requester: 257976, subject: "Atlas CRM inaccessible - erreur de compte (Toulouse)",
    description: "Je ne peux plus me connecter à Atlas CRM depuis Toulouse. Message « Échec de la connexion (ACCT_SVC) », et la réinitialisation du mot de passe ne fonctionne pas non plus. Des collègues ont la même erreur." },
  { kind: "user", requester: 257994, subject: "Atlas CRM - Login nach MFA fehlgeschlagen (Wien)",
    description: "Nach Bestätigung der MFA-Aufforderung landet Atlas CRM wieder auf der Anmeldeseite mit „Anmeldung fehlgeschlagen (MFA)“. Mehrere Kollegen im Wiener Büro sind ebenfalls betroffen." },
  { kind: "user", requester: 257981, subject: "Atlas CRM won't let me sign in - Dublin",
    description: "Atlas CRM keeps returning 'Sign-in failed (IDP_TIMEOUT)' after I enter my password. It started around 20 minutes ago and several people in the Dublin office are affected." },
  { kind: "gcp", requester: MON, subject: "[GCP Monitoring][OPEN] Atlas CRM Ops Down - Failure of uptime check atlas-crm-ops-health",
    description: "Source: Google Cloud Monitoring\nPolicy: Atlas CRM Ops Down\nCondition: Failure of uptime check atlas-crm-ops-health\nState: open\nSummary: monitoring.googleapis.com/uptime_check/check_passed for atlas-crm-ops returned check_passed=false across all checker regions.\nResource: atlas-crm-ops (Cloud Run, asia-south1, atomicwork-gcp-demo)" },
  { kind: "gcp", requester: MON, subject: "[GCP Monitoring][OPEN] Atlas CRM Ops - 5xx error rate high - Cloud Run request_count 5xx above threshold",
    description: "Source: Google Cloud Monitoring\nPolicy: Atlas CRM Ops - 5xx error rate high\nCondition: Cloud Run request_count 5xx above threshold\nState: open\nSummary: run.googleapis.com/request_count response_code_class=5xx at 41.2/s (threshold 5/s).\nResource: atlas-crm-ops (asia-south1)" },
];

// ---- Scenario 2: data-layer outage (customer records / accounts fail to load) ----
const INCIDENTS_DATA = [
  { kind: "user", requester: 257979, subject: "Atlas CRM - customer records will not load (London)",
    description: "I can sign in to Atlas CRM but my customer accounts will not load - the list spins then shows 'Records failed to load (DATA_TIMEOUT)'. The whole London team has the same; we cannot see any account data." },
  { kind: "user", requester: 257998, subject: "Atlas CRM - les comptes clients ne se chargent pas (Paris)",
    description: "Je peux me connecter à Atlas CRM mais mes comptes clients ne s'affichent pas. Message « Échec du chargement des données (RECORDS_503) ». Plusieurs collègues à Paris ont le même problème depuis ce matin." },
  { kind: "user", requester: 258006, subject: "Atlas CRM - Kundendaten laden nicht (München)",
    description: "Ich bin bei Atlas CRM angemeldet, aber die Kundendaten laden nicht. Es erscheint „Daten konnten nicht geladen werden (QUERY_TIMEOUT)“. Im Münchner Büro sind mehrere Kollegen betroffen." },
  { kind: "user", requester: 257983, subject: "Atlas CRM - erreur de chargement des dossiers (Lyon)",
    description: "Atlas CRM s'ouvre mais la liste des comptes reste vide puis affiche « Erreur de chargement (GATEWAY_504) ». Cache vidé, sans effet. Deux personnes à Lyon signalent la même chose." },
  { kind: "user", requester: 257995, subject: "Atlas CRM - Datensätze nicht verfügbar (Berlin)",
    description: "Atlas CRM startet, aber die Datensätze erscheinen nicht. Fehler „Daten nicht verfügbar (DB_CONN_POOL)“. Neu laden hilft nicht. Im Berliner Büro sind mehrere Personen betroffen." },
  { kind: "user", requester: 258005, subject: "Atlas CRM - cannot fetch records (Singapore)",
    description: "Signed in fine to Atlas CRM but the accounts page errors with 'Could not fetch records (ACCOUNTS_FETCH_FAILED)'. My whole Singapore team cannot pull up any customer data." },
  { kind: "user", requester: 258013, subject: "Atlas CRM - aucun compte ne se charge (Marseille)",
    description: "Depuis Marseille, Atlas CRM se connecte mais aucun compte ne se charge, message « Délai dépassé (DATA_TIMEOUT) ». Une collègue rencontre le même souci." },
  { kind: "user", requester: 257975, subject: "Atlas CRM - Kundendatensätze laden nicht (Hamburg)",
    description: "Aus Hamburg: Anmeldung klappt, aber Kundendatensätze laden nicht - „Datensätze konnten nicht geladen werden (RECORDS_503)“. Kollegen sind ebenfalls betroffen." },
  { kind: "user", requester: 257992, subject: "Atlas CRM - account data missing / stale (Sydney)",
    description: "Atlas CRM loads but the account data is missing or badly out of date - I get 'Records failed to load (STALE_DATA)' on refresh. Same for colleagues in Sydney." },
  { kind: "user", requester: 257991, subject: "Atlas CRM - impossible d'afficher les comptes (Genève)",
    description: "À Genève, impossible d'afficher les comptes dans Atlas CRM. La page tourne puis « Erreur de chargement (QUERY_TIMEOUT) ». Plusieurs personnes de l'équipe sont bloquées." },
  { kind: "user", requester: 258001, subject: "Atlas CRM - Kundendaten laden nicht mehr (Zürich)",
    description: "In Zürich lädt Atlas CRM die Kundendaten nicht mehr - „Ladefehler (GATEWAY_504)“. Das Problem besteht seit heute Morgen, mehrere Kollegen betroffen." },
  { kind: "user", requester: 258015, subject: "Atlas CRM - customer records not loading (New York)",
    description: "None of us in New York can load customer records in Atlas CRM. The accounts tab shows 'Could not fetch records (ACCOUNTS_FETCH_FAILED)'. Sign-in works, data does not." },
  { kind: "user", requester: 257976, subject: "Atlas CRM - dossiers clients indisponibles (Toulouse)",
    description: "Depuis Toulouse, Atlas CRM ne charge plus les dossiers clients - « Données indisponibles (DB_CONN_POOL) ». Des collègues rencontrent la même erreur." },
  { kind: "user", requester: 257994, subject: "Atlas CRM - Zeitüberschreitung beim Laden (Wien)",
    description: "Aus dem Wiener Büro: Atlas CRM ist erreichbar, aber die Datensätze laden nicht - „Zeitüberschreitung beim Laden (DATA_TIMEOUT)“. Mehrere Kollegen betroffen." },
  { kind: "user", requester: 257981, subject: "Atlas CRM - records will not load (Dublin)",
    description: "Atlas CRM signs me in but customer records will not load - 'Records failed to load (RECORDS_503)'. Started about 15 minutes ago and several people in Dublin are affected." },
  { kind: "gcp", requester: MON, subject: "[GCP Monitoring][OPEN] Atlas CRM Ops - Cloud SQL query latency high - aw-demo-postgres p95 above threshold",
    description: "Source: Google Cloud Monitoring\nPolicy: Atlas CRM Ops - Cloud SQL query latency high\nCondition: aw-demo-postgres p95 query latency above threshold\nState: open\nSummary: cloudsql.googleapis.com/database query p95 latency 6100 ms (threshold 800 ms); connection pool near max, record fetches timing out.\nResource: aw-demo-postgres (Cloud SQL, asia-south1, atomicwork-gcp-demo)" },
  { kind: "gcp", requester: MON, subject: "[GCP Monitoring][OPEN] Atlas CRM Ops - /api/accounts 5xx high - Cloud Run request_count 5xx on accounts above threshold",
    description: "Source: Google Cloud Monitoring\nPolicy: Atlas CRM Ops - accounts API 5xx high\nCondition: Cloud Run request_count 5xx on /api/accounts above threshold\nState: open\nSummary: run.googleapis.com/request_count response_code_class=5xx on /api/accounts at 33.4/s (threshold 5/s); customer record fetches failing.\nResource: atlas-crm-ops (asia-south1)" },
];
async function fileIncident(it) {
  try {
    const r = await fetch(AW_API_URL, {
      method: "POST",
      headers: { "x-api-key": AW_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ request_source: "PORTAL", request_type: "INCIDENT", requester: String(it.requester),
        subject: it.subject, description: it.description, workspace_id: AW_WORKSPACE_ID, agent_group: AW_GROUP }),
    });
    return r.ok;
  } catch (e) { return false; }
}
async function fireIncidents(list, label) {
  if (!FILE_INCIDENTS || !AW_API_KEY) { console.log("[incidents] skipped (no AW_API_KEY)"); return; }
  console.log("[incidents] filing " + list.length + " (" + label + ") to workspace " + AW_WORKSPACE_ID + " group " + AW_GROUP);
  for (const it of list) {
    const ok = await fileIncident(it);
    console.log("  [" + it.kind + "] " + (ok ? "filed" : "FAILED") + ": " + it.subject.slice(0, 48));
    await new Promise(r => setTimeout(r, 1500 + Math.floor(Math.random() * 2000)));
  }
  console.log("[incidents] complete (" + label + ")");
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x"), path = u.pathname;
  if (path === "/") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end(loginPage()); }
  if (path === "/control") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end(controlPage()); }

  if (path === "/api/login") {
    if (req.method !== "POST") return json(res, 405, { error: "POST only" });
    let raw = "";
    req.on("data", c => raw += c);
    req.on("end", () => {
      let b = {}; try { b = JSON.parse(raw || "{}"); } catch (e) { b = {}; }
      const email = String(b.email || "").trim().toLowerCase();
      if (!email) return json(res, 400, { ok: false, error: "email required" });
      // Admins go to the operator console, never the CRM. A general user cannot
      // reach the console or see other users from here.
      if (isAdminEmail(email)) return json(res, 200, { ok: true, role: "admin", redirect: "/control" });
      const usr = resolveUser(email);
      // If this user's region sign-in is down (operator simulated it), the login
      // itself fails with a real, localized auth error - no other-user data.
      if (broken.has(usr.region)) {
        return json(res, 503, { ok: false, role: "user", code: usr.code, region: usr.region });
      }
      return json(res, 200, { ok: true, role: "user", user: { name: usr.name, email: usr.email, region: usr.region, city: usr.city } });
    });
    return;
  }

  if (path === "/api/health" || path === "/healthz") {
    const region = u.searchParams.get("region");
    if (region && !REGIONS[region]) return json(res, 404, { ok: false, error: "unknown region" });
    const p = healthPayload(region);
    return json(res, p.ok ? 200 : 503, p);
  }
  if (path === "/api/accounts") {
    const region = u.searchParams.get("region") || "APAC", r = REGIONS[region];
    if (!r) return json(res, 404, { error: "unknown region" });
    if (dataOutage) return json(res, 503, { region, error: "Customer records are temporarily unavailable", code: "DATA_UNAVAILABLE", since: dataSince });
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
      let body = {};
      try { body = JSON.parse(raw || "{}"); } catch (e) { body = {}; }
      const region = body.region || u.searchParams.get("region") || "all";
      const scenario = String(body.scenario || u.searchParams.get("scenario") || "signin").toLowerCase();
      const isBreak = path.endsWith("break");
      let filing = false;

      // Scenario 2: data-layer outage (customer records / accounts fail to load).
      if (scenario === "data") {
        if (isBreak) {
          if (!dataOutage) { dataOutage = true; dataSince = Date.now(); }
          if (region === "all" && !dataIncidentsFired) { dataIncidentsFired = true; filing = true; fireIncidents(INCIDENTS_DATA, "data"); }
        } else {
          dataOutage = false;
          if (region === "all") dataIncidentsFired = false;
        }
        return json(res, 200, { ok: true, action: path.split("/").pop(), scenario: "data", data_outage: dataOutage, incidents_filing: filing });
      }

      // Scenario 1 (default): sign-in / auth outage per region.
      const targets = region === "all" ? Object.keys(REGIONS) : [region];
      targets.forEach(k => {
        if (!REGIONS[k]) return;
        if (isBreak) { if (!broken.has(k)) { broken.add(k); brokenSince[k] = Date.now(); } }
        else { broken.delete(k); delete brokenSince[k]; }
      });
      if (isBreak && region === "all" && !incidentsFired) { incidentsFired = true; filing = true; fireIncidents(INCIDENTS, "signin"); }
      if (!isBreak && region === "all") { incidentsFired = false; }
      return json(res, 200, { ok: true, action: path.split("/").pop(), scenario: "signin", broken: [...broken], incidents_filing: filing });
    });
    return;
  }
  json(res, 404, { error: "not found" });
});
server.listen(PORT, () => console.log("Atlas CRM on :" + PORT));
