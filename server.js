// Atlas CRM - internal customer platform (demo). Single-file Node HTTP server,
// no dependencies. Employees across APAC / EMEA / Americas use it. A region can
// be "broken" on demand: employees there see errors, /healthz flips to 503, and
// that is what monitoring watches to open a Major Incident.
//
// Endpoints:
//   GET  /                      employee CRM UI (region switcher, accounts)
//   GET  /control               operator panel to break/restore regions
//   GET  /api/health               overall health (503 if ANY region down)
//   GET  /api/health?region=APAC   per-region health (200/503)
//   GET  /api/accounts?region=  account data, or 503 when that region is down
//   POST /api/control/break     {region|"all"}  (needs x-control-token)
//   POST /api/control/restore   {region|"all"}
//
// State is in-memory, so run a single instance on Cloud Run (min=max=1).

const http = require("http");
const PORT = process.env.PORT || 8791;
const CONTROL_TOKEN = process.env.CONTROL_TOKEN || "atlas-demo-2026";

const REGIONS = {
  APAC: { label: "APAC", hub: "Singapore", users: 1840,
    accounts: [
      ["Meridian Logistics", "Singapore", "Enterprise", "Active", 420000],
      ["Sakura Robotics", "Tokyo", "Enterprise", "Renewal", 610000],
      ["Harbour Freight AU", "Sydney", "Mid-Market", "Active", 155000],
      ["Batik Retail Group", "Jakarta", "Mid-Market", "At risk", 98000],
      ["Kai Semiconductors", "Taipei", "Enterprise", "Active", 720000],
    ] },
  EMEA: { label: "EMEA", hub: "Paris", users: 2610,
    accounts: [
      ["Lumiere Mobility", "Paris", "Enterprise", "Active", 540000],
      ["Thameside Bank", "London", "Enterprise", "Renewal", 880000],
      ["Bavaria Autowerk", "Munich", "Enterprise", "Active", 1250000],
      ["Nordvik Energy", "Oslo", "Mid-Market", "Active", 210000],
      ["Iberia Fresh", "Madrid", "Mid-Market", "At risk", 74000],
    ] },
  AMER: { label: "Americas", hub: "New York", users: 2190,
    accounts: [
      ["Hudson Analytics", "New York", "Enterprise", "Active", 690000],
      ["Golden Gate Health", "San Francisco", "Enterprise", "Renewal", 930000],
      ["Prairie Foods", "Chicago", "Mid-Market", "Active", 168000],
      ["Andes Telecom", "Sao Paulo", "Enterprise", "At risk", 305000],
      ["Maple Freight", "Toronto", "Mid-Market", "Active", 142000],
    ] },
};

const broken = new Set(); // region keys currently "down"

function fmtMoney(n) { return "$" + n.toLocaleString("en-US"); }
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

function healthPayload(region) {
  const keys = region ? [region] : Object.keys(REGIONS);
  const regions = {};
  let ok = true;
  keys.forEach(k => {
    const up = REGIONS[k] && !broken.has(k);
    regions[k] = up ? "healthy" : "down";
    if (!up) ok = false;
  });
  return { ok, regions, checked_at: new Date().toISOString() };
}

// ── UI ───────────────────────────────────────────────────────────────────────
function page(body, extraHead) {
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
.top .who{margin-left:auto;color:var(--muted);font-size:12px}
.wrap{max-width:1100px;margin:0 auto;padding:22px}
.tabs{display:flex;gap:6px;margin-bottom:18px}
.tabs a{padding:6px 14px;border:1px solid var(--border);border-radius:7px;background:var(--surface);
color:var(--muted);font-weight:600;font-size:13px;text-decoration:none}
.tabs a.on{background:var(--accent);color:#fff;border-color:var(--accent)}
.banner{border-radius:9px;padding:12px 16px;margin-bottom:18px;font-weight:600;display:none}
.banner.show{display:block}
.banner.down{background:var(--red-bg);color:var(--red);border:1px solid var(--red)}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:18px}
.kpi{background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:14px 16px}
.kpi .v{font-size:24px;font-weight:800;letter-spacing:-.4px}
.kpi .l{font-size:12px;color:var(--muted);margin-top:2px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:9px;overflow:hidden}
.card h3{font-size:13px;font-weight:700;padding:12px 16px;border-bottom:1px solid var(--border)}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:9px 16px;font-size:11px;text-transform:uppercase;letter-spacing:.4px;
color:var(--muted);background:var(--bg);border-bottom:1px solid var(--border)}
td{padding:9px 16px;border-bottom:1px solid var(--border)}
tr:last-child td{border-bottom:none}
.pill{display:inline-block;padding:2px 9px;border-radius:11px;font-size:11px;font-weight:600}
.pill.Active{background:var(--green-bg);color:var(--green)}
.pill.Renewal{background:var(--accent-bg);color:var(--accent)}
.pill\\[at\\]{}
.pill.risk{background:var(--amber-bg);color:var(--amber)}
.err{padding:34px 16px;text-align:center;color:var(--red);font-weight:600}
.err small{display:block;color:var(--muted);font-weight:400;margin-top:6px}
.regsel{margin-left:auto;display:flex;gap:6px;align-items:center}
.regsel select{font-family:inherit;font-size:13px;padding:5px 10px;border:1px solid var(--border);border-radius:7px;background:var(--surface)}
.controls{display:flex;flex-direction:column;gap:10px}
.crow{background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:14px 16px;display:flex;align-items:center;gap:14px}
.crow .rl{font-weight:700;min-width:120px}
.crow .st{font-size:12px;font-weight:600;padding:2px 10px;border-radius:11px}
.crow .st.up{background:var(--green-bg);color:var(--green)}
.crow .st.dn{background:var(--red-bg);color:var(--red)}
.crow .sp{margin-left:auto;display:flex;gap:8px}
button{font-family:inherit;font-size:13px;font-weight:600;padding:7px 14px;border-radius:7px;border:1px solid var(--border);background:var(--surface);cursor:pointer}
button.break{border-color:var(--red);color:var(--red)}
button.fix{border-color:var(--green);color:var(--green)}
button:hover{filter:brightness(.97)}
.hint{color:var(--muted);font-size:12px;margin-top:8px}
</style>${extraHead || ""}</head><body>
<div class="top"><div class="logo"><span class="dot"></span>Atlas CRM</div>
<span class="sub">Internal Customer Platform</span>
<span class="who">Signed in: Priya Nair . Sales Ops</span></div>
<div class="wrap">${body}</div></body></html>`;
}

function crmPage() {
  const body = `
<div class="tabs"><a class="on" href="/">Accounts</a><a href="/control">Service status</a></div>
<div id="banner" class="banner down"></div>
<div class="kpis">
  <div class="kpi"><div class="v" id="k-acc">--</div><div class="l">Accounts in region</div></div>
  <div class="kpi"><div class="v" id="k-arr">--</div><div class="l">Total ARR</div></div>
  <div class="kpi"><div class="v" id="k-usr">--</div><div class="l">Active users</div></div>
  <div class="kpi"><div class="v" id="k-risk">--</div><div class="l">At-risk accounts</div></div>
</div>
<div class="card">
  <h3 style="display:flex;align-items:center">Accounts
    <span class="regsel">Region
      <select id="reg" onchange="load()">
        <option value="APAC">APAC</option><option value="EMEA">EMEA</option><option value="AMER">Americas</option>
      </select></span></h3>
  <div id="tbl"></div>
</div>
<script>
async function load(){
  var reg=document.getElementById('reg').value;
  var tbl=document.getElementById('tbl'), ban=document.getElementById('banner');
  tbl.innerHTML='<div class="err" style="color:var(--muted)">Loading...</div>';
  try{
    var r=await fetch('/api/accounts?region='+reg,{cache:'no-store'});
    if(!r.ok){ throw new Error('HTTP '+r.status); }
    var d=await r.json();
    ban.className='banner';
    document.getElementById('k-acc').textContent=d.accounts.length;
    document.getElementById('k-arr').textContent='$'+(d.arr).toLocaleString('en-US');
    document.getElementById('k-usr').textContent=d.users.toLocaleString('en-US');
    document.getElementById('k-risk').textContent=d.accounts.filter(function(a){return a[3]==='At risk'}).length;
    var rows=d.accounts.map(function(a){
      var cls=a[3]==='At risk'?'risk':a[3];
      return '<tr><td><strong>'+a[0]+'</strong></td><td>'+a[1]+'</td><td>'+a[2]+'</td>'+
        '<td><span class="pill '+cls+'">'+a[3]+'</span></td><td style="text-align:right">$'+a[4].toLocaleString('en-US')+'</td></tr>';
    }).join('');
    tbl.innerHTML='<table><thead><tr><th>Account</th><th>City</th><th>Segment</th><th>Status</th><th style="text-align:right">ARR</th></tr></thead><tbody>'+rows+'</tbody></table>';
  }catch(e){
    ban.className='banner down show';
    ban.textContent='Service degraded in '+reg+'. Account data is unavailable. IT has been notified.';
    document.getElementById('k-acc').textContent='--';document.getElementById('k-arr').textContent='--';
    document.getElementById('k-usr').textContent='--';document.getElementById('k-risk').textContent='--';
    tbl.innerHTML='<div class="err">Unable to reach Atlas CRM services for '+reg+'.<small>Error '+e.message+' . Retrying automatically.</small></div>';
  }
}
load();
setInterval(load,5000);
</script>`;
  return page(body);
}

function controlPage() {
  const rows = Object.keys(REGIONS).map(k => {
    const up = !broken.has(k);
    return `<div class="crow"><span class="rl">${REGIONS[k].label}</span>
      <span class="st ${up ? "up" : "dn"}" id="st-${k}">${up ? "Healthy" : "Down"}</span>
      <span class="sp">
        <button class="break" onclick="act('break','${k}')">Break</button>
        <button class="fix" onclick="act('restore','${k}')">Restore</button>
      </span></div>`;
  }).join("");
  const body = `
<div class="tabs"><a href="/">Accounts</a><a class="on" href="/control">Service status</a></div>
<div class="card" style="margin-bottom:16px"><h3>Region health (what monitoring sees)</h3>
  <div style="padding:14px 16px" id="hz">checking...</div></div>
<h3 style="font-size:13px;margin-bottom:10px">Operator controls</h3>
<div class="controls">${rows}
  <div class="crow"><span class="rl">All regions</span><span class="sp" style="margin-left:auto;display:flex;gap:8px">
    <button class="break" onclick="act('break','all')">Break all</button>
    <button class="fix" onclick="act('restore','all')">Restore all</button></span></div>
</div>
<div class="hint">Breaking a region flips /api/health to 503 for that region. A monitoring uptime check on /api/health opens a Major Incident in Atomicwork.</div>
<script>
var TOKEN='${CONTROL_TOKEN}';
async function refresh(){
  var r=await fetch('/api/health?all=1',{cache:'no-store'}); var d=await r.json();
  document.getElementById('hz').innerHTML=Object.keys(d.regions).map(function(k){
    var up=d.regions[k]==='healthy';
    return '<span style="margin-right:16px"><strong>'+k+'</strong>: <span style="color:'+(up?'var(--green)':'var(--red)')+'">'+d.regions[k]+'</span></span>';
  }).join('')+' <span style="color:var(--muted);font-size:12px">(overall '+(d.ok?'200':'503')+')</span>';
  Object.keys(d.regions).forEach(function(k){var el=document.getElementById('st-'+k);if(el){var up=d.regions[k]==='healthy';el.textContent=up?'Healthy':'Down';el.className='st '+(up?'up':'dn');}});
}
async function act(op,region){
  await fetch('/api/control/'+op,{method:'POST',headers:{'Content-Type':'application/json','x-control-token':TOKEN},body:JSON.stringify({region:region})});
  refresh();
}
refresh();setInterval(refresh,3000);
</script>`;
  return page(body);
}

// ── Server ─────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const path = u.pathname;

  if (path === "/" ) { res.writeHead(200, { "Content-Type": "text/html" }); return res.end(crmPage()); }
  if (path === "/control") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end(controlPage()); }

  if (path === "/api/health" || path === "/healthz") {
    // Note: Cloud Run's front end reserves /healthz, so /api/health is the
    // path monitoring should watch.
    const region = u.searchParams.get("region");
    if (region && !REGIONS[region]) return json(res, 404, { ok: false, error: "unknown region" });
    const p = healthPayload(region);
    return json(res, p.ok ? 200 : 503, p);
  }

  if (path === "/api/accounts") {
    const region = u.searchParams.get("region") || "APAC";
    if (!REGIONS[region]) return json(res, 404, { error: "unknown region" });
    if (broken.has(region)) return json(res, 503, { error: "region unavailable", region });
    const r = REGIONS[region];
    const arr = r.accounts.reduce((a, x) => a + x[4], 0);
    return json(res, 200, { region, hub: r.hub, users: r.users, arr, accounts: r.accounts });
  }

  if (path === "/api/control/break" || path === "/api/control/restore") {
    if (req.method !== "POST") return json(res, 405, { error: "POST only" });
    if ((req.headers["x-control-token"] || u.searchParams.get("token")) !== CONTROL_TOKEN)
      return json(res, 401, { error: "bad control token" });
    let raw = "";
    req.on("data", c => raw += c);
    req.on("end", () => {
      let region = "all";
      try { region = (JSON.parse(raw || "{}").region) || u.searchParams.get("region") || "all"; }
      catch (e) { region = u.searchParams.get("region") || "all"; }
      const targets = region === "all" ? Object.keys(REGIONS) : [region];
      targets.forEach(k => { if (REGIONS[k]) { if (path.endsWith("break")) broken.add(k); else broken.delete(k); } });
      return json(res, 200, { ok: true, action: path.split("/").pop(), broken: [...broken] });
    });
    return;
  }

  json(res, 404, { error: "not found" });
});

server.listen(PORT, () => console.log("Atlas CRM on :" + PORT));
