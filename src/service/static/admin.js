const $ = id => document.getElementById(id);
const state = { me: null, seq: 0, users: [] };

// safe templating
class Raw { constructor(s) { this.s = s; } }
const esc = s => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const part = v => v instanceof Raw ? v.s : Array.isArray(v) ? v.map(part).join("") : esc(v ?? "");
const html = (strs, ...vals) => new Raw(strs.reduce((acc, s, i) => acc + s + (i < vals.length ? part(vals[i]) : ""), ""));
const show = (el, v) => { $(el).innerHTML = part(v); };

// formatting
const num = n => Number(n).toLocaleString();
const compact = n => Intl.NumberFormat("en-US", {notation:"compact", maximumFractionDigits:1}).format(n);
const usd = n => "$" + Number(n).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2});
const PERIODS = [
  ["Months", [["2026-08","August 2026"],["2026-09","September 2026 (partial)"]]],
  ["Rolling", [["last_7_days","Last 7 days"],["last_30_days","Last 30 days"]]],
  ["ISO weeks", Array.from({length:8}, (_, i) => [`2026-W${32+i}`, `2026-W${32+i}`])],
];
const PLATFORMS = ["claude", "gemini"];
const platformName = p => p === "claude" ? "Claude" : "Gemini";

// api
class ApiError extends Error { constructor(status, body) { super(body.reason || body.detail || `HTTP ${status}`); this.status = status; this.body = body; } }
async function api(path, opts = {}) {
  const r = await fetch(path, {...opts, headers: {"X-Meridian-User": $("who").value, "Content-Type": "application/json"}});
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, body);
  return body;
}
const denial = e => e.status === 403
  ? `Not permitted: ${e.message}` + (e.body.required_scope ? ` (needs ${e.body.required_scope})` : "")
  : e.message;
function banner(msg) { const b = $("banner"); b.textContent = msg || ""; b.className = "banner err" + (msg ? " show" : ""); }

// view pieces
const swatch = p => html`<i class="dot" style="background:var(--${p})"></i>${platformName(p)}`;
const stateLabel = on => html`<span class="state ${on ? "on" : "off"}">${on ? "On" : "Off"}</span>`;
const bar = (pct, color, min = 80) => html`<div class="bar" style="min-width:${min}px"><span style="width:${pct}%;background:${color}"></span></div>`;
const splitBar = (c, g) => { const t = c + g || 1; return html`<div class="bar" role="img" aria-label="Claude ${usd(c)}, Gemini ${usd(g)}"><span style="width:${100*c/t}%;background:var(--claude)"></span><span style="width:${100*g/t}%;background:var(--gemini)"></span></div>`; };
const empty = msg => html`<div class="empty">${msg}</div>`;
const NO_DATA = "No data for this selection";

function table(head, rows, emptyMsg = NO_DATA) {
  return html`<thead><tr>${head.map(h => html`<th scope="col">${h}</th>`)}</tr></thead><tbody>${
    rows.length ? rows.map(r => html`<tr>${r.map(c => html`<td>${c}</td>`)}</tr>`)
                : html`<tr><td colspan="${head.length}" class="empty">${emptyMsg}</td></tr>`}</tbody>`;
}

function kpiCards(d) {
  const [c, m] = PLATFORMS.map(p => d.platforms.find(x => x.platform === p));
  const share = x => d.totals.cost_usd ? Math.round(100 * x.cost_usd / d.totals.cost_usd) + "% of cost" : "";
  return [["Total cost", usd(d.totals.cost_usd), `${d.period.start} → ${d.period.end_exclusive}`],
    ["Total tokens", compact(d.totals.total_tokens), num(d.totals.total_tokens)],
    [swatch("claude"), usd(c.cost_usd), `${compact(c.total_tokens)} tokens · ${share(c)}`],
    [swatch("gemini"), usd(m.cost_usd), `${compact(m.total_tokens)} tokens · ${share(m)}`]]
    .map(([l, v, s]) => html`<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`);
}

function weeklyChart(rows) {
  if (!rows.length) return empty(NO_DATA);
  const weeks = [...new Set(rows.map(r => r.week))];
  const cost = (w, p) => rows.find(r => r.week === w && r.platform === p)?.cost_usd ?? 0;
  const max = Math.max(...weeks.map(w => cost(w, "claude") + cost(w, "gemini")), 1);
  const W = 700, H = 220, L = 64, B = 26, T = 8, step = (W - L) / weeks.length, bw = Math.min(56, step * 0.6);
  const y = v => T + (H - T - B) * (1 - v / max);
  const grid = [0, .5, 1].map(f => html`<line class="grid" x1="${L}" x2="${W}" y1="${y(max*f)}" y2="${y(max*f)}"/><text x="${L-6}" y="${y(max*f)+4}" text-anchor="end">${"$" + Math.round(max*f).toLocaleString()}</text>`);
  const bars = weeks.map((w, i) => {
    const x = L + i * step + (step - bw) / 2, c = cost(w, "claude"), g = cost(w, "gemini");
    return html`<g><title>${w}: Claude ${usd(c)}, Gemini ${usd(g)}, total ${usd(c+g)}</title><rect x="${x}" y="${y(c)}" width="${bw}" height="${y(0)-y(c)}" fill="var(--claude)" rx="2"/><rect x="${x}" y="${y(c+g)}" width="${bw}" height="${y(c)-y(c+g)}" fill="var(--gemini)" rx="2"/></g><text x="${x+bw/2}" y="${H-8}" text-anchor="middle">${w.slice(5)}</text>`;
  });
  return html`<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Weekly cost, stacked by platform">${grid}${bars}</svg>`;
}

function weeklyRows(rows) {
  return [...new Set(rows.map(r => r.week))].map(w => {
    const rs = rows.filter(r => r.week === w), by = p => rs.find(r => r.platform === p)?.cost_usd ?? 0;
    return [w, rs[0].week_start, usd(by("claude")), usd(by("gemini")), num(rs.reduce((a, r) => a + r.total_tokens, 0)), usd(by("claude") + by("gemini"))];
  });
}

function groupBars(d) {
  const cost = (id, p) => d.rows.find(r => r.group === id && r.platform === p)?.cost_usd ?? 0;
  const gs = d.groups.map(id => ({id, c: cost(id, "claude"), m: cost(id, "gemini")})).map(x => ({...x, t: x.c + x.m})).sort((a, b) => b.t - a.t);
  const max = Math.max(...gs.map(x => x.t), 1);
  return gs.map(x => html`<div style="margin:8px 0"><div style="display:flex;justify-content:space-between"><span>${x.id}</span><b>${usd(x.t)}</b></div><div style="width:${Math.max(4, 100*x.t/max)}%">${splitBar(x.c, x.m)}</div></div>`);
}

function capabilityMatrix(d, selected) {
  const cell = (g, c) => {
    const x = g.capabilities[c];
    if (!x) return html`<td>—</td>`;
    const why = x.updated_at ? `Changed ${x.updated_at} by ${x.updated_by}` : "Environment default";
    const lock = g.can_write ? "" : new Raw('disabled title="Needs capabilities:write for this group"');
    return html`<td><span class="cell"><span class="state ${x.enabled ? "on" : "off"}" title="${why}">${x.enabled ? "On" : "Off"}</span> <button class="switch" role="switch" aria-checked="${x.enabled}" aria-label="${c} for ${g.group}" data-group="${g.group}" data-cap="${c}" ${lock}></button></span></td>`;
  };
  const row = g => html`<tr${g.group === selected ? new Raw(' style="background:var(--track)"') : ""}><td><b>${g.group}</b></td>${d.capabilities.map(c => cell(g, c))}</tr>`;
  return html`<table><thead><tr><th scope="col">Group</th>${d.capabilities.map(c => html`<th scope="col">${c}</th>`)}</tr></thead><tbody>${d.groups.map(row)}</tbody></table>`;
}

function healthPanel(d) {
  return html`<div style="margin-bottom:8px">Data runs to <b>${d.data_end_exclusive}</b> (exclusive). Ingest issues: <span class="chip ${d.ingest_issues ? "deny" : "on"}">${d.ingest_issues}</span></div>
    <table>${table(["Platform", "Rows", "Users", "First day", "Last day"], d.platforms.map(p => [swatch(p.platform), num(p.rows), p.users, p.first_day, p.last_day]))}</table>${
    d.issues.length ? html`<details open><summary>Issues</summary>${d.issues.map(i => html`<div style="font-size:12px">${i.source} ${i.ref}: ${i.reason}</div>`)}</details>` : ""}`;
}

// loaders
async function loadAll() {
  const my = ++state.seq, stale = () => my !== state.seq;
  const p = encodeURIComponent($("period").value), g = encodeURIComponent($("group").value);
  for (const id of ["weekly", "groups", "caps"]) show(id, html`<div class="loading">Loading</div>`);
  const section = (el, fn) => fn().catch(e => { if (!stale()) show(el, el.startsWith("t-") ? table(["Unavailable"], [[denial(e)]]) : empty(denial(e))); });
  const fetchTo = async (url, render) => { const d = await api(url); if (!stale()) render(d); };

  await Promise.all([
    section("kpis", () => fetchTo(`/api/v1/usage/summary?period=${p}&group=${g}`, d => {
      show("kpis", kpiCards(d));
      const pb = $("partial"); pb.className = "banner warn" + (d.period.partial ? " show" : "");
      pb.textContent = d.period.partial ? "This period runs past the end of the data (2026-09-28); figures cover the days available." : "";
      show("t-platform", table(["Platform", "Requests", "Input", "Output", "Total", "Cost"], d.platforms.map(x =>
        [swatch(x.platform), x.requests == null ? "—" : num(x.requests), num(x.input_tokens), num(x.output_tokens), num(x.total_tokens), usd(x.cost_usd)])));
    })),
    section("weekly", () => fetchTo(`/api/v1/usage?period=${p}&by=week&by=platform&group=${g}`, d => {
      show("weekly", weeklyChart(d.rows));
      show("t-week", table(["Week", "Starts", "Claude", "Gemini", "Total tokens", "Total cost"], weeklyRows(d.rows)));
    })),
    section("groups", () => fetchTo(`/api/v1/usage?period=${p}&by=group&by=platform`, d => {
      $("h-groups").textContent = d.groups.length > 1 ? "By group" : "Your group";
      show("groups", d.groups.length ? groupBars(d) : empty(NO_DATA));
    })),
    section("t-users", () => fetchTo(`/api/v1/usage/by-user?period=${p}&group=${g}`, d => {
      const max = Math.max(...d.map(x => x.total_tokens), 1);
      $("users-note").textContent = `${d.length} member${d.length === 1 ? "" : "s"} of ${$("group").value}`;
      show("t-users", table(["User", "Role", "Claude tokens", "Gemini tokens", "Total tokens", "", "Cost"],
        d.map(x => [x.name, x.role.replace("_", " "), num(x.claude.total_tokens), num(x.gemini.total_tokens), num(x.total_tokens),
          bar(100 * x.total_tokens / max, "var(--accent)", 100), usd(x.cost_usd)])));
    })),
    section("caps", () => loadCaps(stale)),
    section("t-audit", () => loadAudit(stale)),
    section("health", () => loadHealth(stale)),
  ]);
}

async function loadCaps(stale) {
  const d = await api("/api/v1/capabilities/matrix"); if (stale()) return;
  $("cap-note").textContent = d.groups.some(g => g.can_write) ? "you can change switches for groups you control" : "read-only for your role";
  show("caps", capabilityMatrix(d, $("group").value));
  document.querySelectorAll("#caps .switch").forEach(b => b.onclick = async () => {
    b.disabled = true;
    try { await api(`/api/v1/capabilities/${b.dataset.group}/${b.dataset.cap}`, {method: "PUT", body: JSON.stringify({enabled: b.getAttribute("aria-checked") !== "true"})}); banner(""); }
    catch (e) { banner(denial(e)); }
    loadCaps(() => false); loadAudit(() => false);
  });
}

const ACTIONS = {capability_set: "Group switch", override_set: "User override", override_cleared: "Override cleared", suspended: "Suspended", restored: "Restored"};
const when = t => t.replace("T", " ").replace("Z", "");
const what = r => [r.capability, r.detail].filter(Boolean).join(": ") || "-";

async function loadAudit(stale) {
  const card = $("audit-card");
  card.hidden = !state.me.scopes.includes("capabilities:write");
  if (card.hidden) return;
  const d = await api("/api/v1/admin/audit?limit=15"); if (stale()) return;
  show("t-audit", table(["When (UTC)", "Group", "User", "Action", "Detail", "By"],
    d.map(r => [when(r.changed_at), r.group, r.user_name ?? "-", ACTIONS[r.action], what(r), r.changed_by.split("@")[0]]),
    "No changes yet. Every change is recorded here."));
}

async function loadHealth(stale) {
  const card = $("health-card");
  let d;
  try { d = await api("/api/v1/admin/data-health"); } catch (e) { if (e.status === 403) { card.hidden = true; $("manage-card").hidden = true; return; } throw e; }
  if (stale()) return;
  card.hidden = false;
  show("health", healthPanel(d));
  $("manage-card").hidden = false;   // same gate as data health
  loadManage();
}

// manage a user
const OVERRIDE = {inherit: "Inherit group", on: "Force on", off: "Force off"};

function manageView(u, caps, suspension, history, isSelf) {
  const t = u.totals;
  const status = suspension
    ? html`<span class="chip deny">Suspended</span> <span style="color:var(--muted)">since ${suspension.suspended_at.replace("T", " ").replace("Z", "")} by ${suspension.suspended_by.split("@")[0]}${suspension.reason ? ` — ${suspension.reason}` : ""}</span>`
    : html`<span class="chip on">Active</span>`;
  const action = suspension
    ? html`<button id="mu-restore" class="btn">Restore access</button>`
    : html`<input id="mu-reason" placeholder="Reason (optional)" maxlength="200" aria-label="Suspension reason" style="font:inherit;padding:5px 8px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--fg)"> <button id="mu-suspend" class="btn danger" ${isSelf ? new Raw('disabled title="You cannot suspend your own account"') : ""}>Suspend</button>`;
  const overrideSelect = c => {
    const current = c.source === "user_override" ? (c.enabled ? "on" : "off") : "inherit";
    return html`<select class="mu-cap" data-cap="${c.capability}" aria-label="${c.capability} override">${Object.entries(OVERRIDE).map(([v, l]) => html`<option value="${v}" ${v === current ? new Raw("selected") : ""}>${l}</option>`)}</select>`;
  };
  const capRows = caps.map(c => [c.capability, stateLabel(c.enabled), c.source === "user_override" ? "User override" : "Group setting", overrideSelect(c)]);
  return html`
    <div style="margin:12px 0"><b>${u.user.name}</b> · ${u.user.email} · ${u.user.role.replace("_", " ")} · ${u.user.group} &nbsp; ${status}</div>
    <div style="margin-bottom:12px">${action}</div>
    <h2>Usage in the selected period <span class="chip">${usd(t.cost_usd)} · ${compact(t.total_tokens)} tokens</span></h2>
    <div class="grid2">
      <div class="scroll"><table>${table(["Week", "Claude", "Gemini", "Total tokens", "Cost"], u.weeks.map(w => [w.week, num(w.claude.total_tokens), num(w.gemini.total_tokens), num(w.total_tokens), usd(w.cost_usd)]))}</table></div>
      <div class="scroll"><table>${table(["Platform", "Model", "Total tokens", "Cost"], u.models.map(m => [swatch(m.platform), m.model, num(m.total_tokens), usd(m.cost_usd)]))}</table></div>
    </div>
    <h2 style="margin-top:16px">Capabilities for this user</h2>
    <div class="scroll"><table>${table(["Capability", "Effective", "Source", "Override"], capRows)}</table></div>
    <h2 style="margin-top:16px">Recent actions on this user</h2>
    <div class="scroll"><table>${table(["When (UTC)", "Action", "Detail", "By"], history.map(h => [when(h.changed_at), ACTIONS[h.action], what(h), h.changed_by.split("@")[0]]), "No admin actions on this user yet.")}</table></div>`;
}

async function loadManage() {
  if ($("manage-card").hidden || !$("mu-user").value) return;
  const id = $("mu-user").value, p = encodeURIComponent($("period").value), base = `/api/v1/admin/users`;
  try {
    const [usage, caps, susp, audit] = await Promise.all([api(`${base}/${id}/usage?period=${p}`), api(`${base}/${id}/capabilities`), api(`${base}/suspensions`), api("/api/v1/admin/audit?limit=200")]);
    if (id !== $("mu-user").value) return;
    show("mu-body", manageView(usage, caps, susp.find(x => x.user_id === id), audit.filter(a => a.user_id === id).slice(0, 8), id === state.me.user_id));
    const act = async (path, body) => { try { await api(path, {method: "PUT", body: JSON.stringify(body)}); banner(""); } catch (e) { banner(denial(e)); } loadManage(); loadCaps(() => false); };
    $("mu-suspend")?.addEventListener("click", () => act(`${base}/${id}/suspension`, {suspended: true, reason: $("mu-reason").value}));
    $("mu-restore")?.addEventListener("click", () => act(`${base}/${id}/suspension`, {suspended: false}));
    document.querySelectorAll(".mu-cap").forEach(sel => sel.addEventListener("change", () =>
      act(`${base}/${id}/capabilities/${sel.dataset.cap}`, {enabled: sel.value === "inherit" ? null : sel.value === "on"})));
  } catch (e) { show("mu-body", empty(denial(e))); }
}

async function loadIdentity() {
  banner("");
  try { state.me = await api("/api/v1/me"); } catch (e) { banner(denial(e)); return; }
  const me = state.me;
  $("env").textContent = me.environment; $("env").className = "env " + me.environment;
  const prev = $("group").value;
  show("group", me.readable_groups.map(g => html`<option>${g}</option>`));
  if (!me.readable_groups.length) {
    show("access", html`<span>Role</span><span class="chip">${me.role}</span><span class="chip deny">no usage:read in ${me.environment}</span>`);
    $("data").hidden = true;
    banner(`Your role (${me.role}) does not have usage:read in ${me.environment}. Nothing is shown.`);
    return;
  }
  $("data").hidden = false;
  $("group").value = me.readable_groups.includes(prev) ? prev : (me.groups.find(x => me.readable_groups.includes(x)) || me.readable_groups[0]);
  const scope = s => html`<span class="chip ${me.scopes.includes(s) ? "on" : "off"}">${s}</span>`;
  show("access", html`<span>Role</span><span class="chip">${me.role}</span><span>Scopes</span>${scope("usage:read")}${scope("capabilities:write")}<span>Can read</span><span class="chip">${me.readable_groups.length === 6 ? "all groups" : me.readable_groups.join(", ")}</span>`);
  loadAll();
}

// remember the last pick in this browser, not in the url
const REMEMBER = "meridian.actingAs";
const remembered = () => { try { return localStorage.getItem(REMEMBER); } catch { return null; } };
const remember = v => { try { localStorage.setItem(REMEMBER, v); } catch { } };

(async function init() {
  show("period", PERIODS.map(([label, opts]) => html`<optgroup label="${label}">${opts.map(([v, t]) => html`<option value="${v}">${t}</option>`)}</optgroup>`));
  $("period").value = "2026-08";
  const { users, default_user } = await (await fetch("/api/v1/identities")).json();
  const order = {platform_admin: 0, team_lead: 1, member: 2};
  users.sort((a, b) => order[a.role] - order[b.role] || a.name.localeCompare(b.name));
  show("who", users.map(u => html`<option value="${u.email}">${u.name} · ${u.role.replace("_", " ")} · ${u.groups[0]}</option>`));
  state.users = users;
  show("mu-user", [...users].sort((a, b) => a.name.localeCompare(b.name)).map(u => html`<option value="${u.user_id}">${u.name} · ${u.role.replace("_", " ")} · ${u.groups[0]}</option>`));
  $("mu-user").onchange = loadManage;
  const known = e => users.some(u => u.email === e);
  $("who").value = [remembered(), default_user].find(e => e && known(e)) ?? users[0].email;
  $("who").onchange = () => { remember($("who").value); loadIdentity(); };
  $("group").onchange = loadAll; $("period").onchange = () => { loadAll(); };
  loadIdentity();
})();
