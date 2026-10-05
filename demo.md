# Demo walkthrough

This walks through the whole project in order: the usage service, the admin page, the connector inside the assistant, and the provisioning. Every step has the command and the expected result. The numbers below come from a fresh database.

Two terminals are used (Terminal 1 for the server, Terminal 2 for the commands), plus a browser.

People used in the demo:

| Name | Email | Role | Team |
| --- | --- | --- | --- |
| Priya Nair | priya.nair@meridianls.example | team lead | clinical-operations |
| Daniel Okafor | daniel.okafor@meridianls.example | member | clinical-operations |
| Sofia Rossi | sofia.rossi@meridianls.example | team lead | finance |
| Chloe Dubois | chloe.dubois@meridianls.example | platform admin | it-platform |

The data covers 2026-08-03 to 2026-09-27, so "last month" means `2026-08`.

---

## 0. Setup

The demo changes data (it enables a capability and can suspend a user), so it starts from a fresh database each time.

**Terminal 1**, the service:

```bash
cd ~/meridian-usage-connector
rm -f var/prod.sqlite
npm run bundle
make serve ENV=prod PORT=8083
```

Expected: `meridian usage service listening on http://127.0.0.1:8083`

**Terminal 2**, helper functions and the connector config:

```bash
cd ~/meridian-usage-connector
export B=http://127.0.0.1:8083
export ADMIN=chloe.dubois@meridianls.example LEAD=priya.nair@meridianls.example
export FIN=sofia.rossi@meridianls.example MEMBER=daniel.okafor@meridianls.example
get() { curl -s -w ' [HTTP %{http_code}]\n' -H "X-Meridian-User: $1" "$B$2"; }
put() { curl -s -w ' [HTTP %{http_code}]\n' -X PUT -H 'Content-Type: application/json' -H "X-Meridian-User: $1" -d "$3" "$B$2"; }
show() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=s.match(/^([\s\S]*?)\s*\[HTTP (\d+)\]\s*$/);const b=m?m[1]:s;try{const j=JSON.parse(b);if(m)console.log("HTTP "+m[2]);const t=x=>{x=JSON.stringify(x);return x.length>120?x.slice(0,119)+"…":x};if(Array.isArray(j))j.slice(0,6).forEach((x,i)=>console.log("  ["+i+"] "+t(x)));else for(const [k,v] of Object.entries(j))console.log("  "+k+": "+t(v))}catch{console.log(s.trim())}})'; }
npm run --silent render -- --out build/local --install-root "$PWD"
node -e "const c=require('./build/local/prod/claude-desktop.json').mcpServers['meridian-usage']; c.env.MERIDIAN_USER='priya.nair@meridianls.example'; require('fs').writeFileSync('build/local/mcp-lead.json', JSON.stringify({mcpServers:{'meridian-usage':c}}))"
clear
```

Health check:

```bash
curl -s $B/health
```

Expected: `{"status":"ok","environment":"prod","ingest_issues":0}`

The browser pages used later: the repository at https://github.com/pushpendra20mishra/meridian-usage-connector and the admin page at http://127.0.0.1:8083/admin.

---

## 1. Architecture

The README diagram shows the flow: the Claude and Gemini exports are ingested into one model, the service exposes an API and an admin page, and the connector exposes the same data inside the assistant, checking permissions on every call.

---

## 2. The two data formats

```bash
node -e "const c=require('./data/claude/user_cost_report.json').data[0]; console.log('claude:', c.amount, 'cents,', c.cost_type, c.rbac_group_id)"
```

Expected: `claude: 88.900050 cents, tokens rbac_group_...`. Claude reports money as a string of cents.

```bash
head -n1 data/gemini/gcp_billing_export_v1_01A2B3_C4D5E6_F7A8B9.jsonl | cut -c1-330
```

Expected: one JSON line containing `"description": "Vertex AI"`. Gemini reports money as a float in dollars, and the person is only present as an `owner` label.

---

## 3. A team lead sees their own team

```bash
get $LEAD "/api/v1/usage/summary?period=2026-08" | show
```

Expected: `HTTP 200`, `group: "clinical-operations"`, `totals: {"total_tokens":16614944,"cost_usd":145.951956}`.

## 4. A team lead cannot see another team

```bash
get $LEAD "/api/v1/usage/summary?period=2026-08&group=finance" | show
```

Expected: `HTTP 403`, `error: "permission_denied"`, `reason: "role 'team_lead' may only access its own group (clinical-operations), not another group"`. The response contains no usage numbers.

## 5. A team lead cannot change settings

```bash
put $LEAD /api/v1/capabilities/clinical-operations/web-search '{"enabled":false}' | show
```

Expected: `HTTP 403`, `required_scope: "capabilities:write"`.

## 6. An admin can change settings, and the change is recorded

```bash
put $ADMIN /api/v1/capabilities/finance/usage-connector '{"enabled":true}' | show
get $ADMIN /api/v1/admin/audit | show
```

Expected: `HTTP 200`, `enabled: true`, `updated_by: "chloe.dubois@..."`. The audit log then shows one entry with `"action":"capability_set"` (who, what, when).

## 7. An admin sees every team

```bash
get $ADMIN "/api/v1/usage?period=2026-08&by=group" | show
```

Expected: six groups. Costs, rounded: it-platform 1045.27, regulatory-affairs 306.16, clinical-operations 145.95, medical-writing 78.84, hr 49.18, finance 11.29.

---

## 8. The admin page

Open http://127.0.0.1:8083/admin and use the "Acting as" dropdown to switch between three people:

| Who | What the page shows |
| --- | --- |
| Chloe Dubois (admin) | every team, weekly cost chart, usage per person, working capability switches, change log, data health, "Manage a user" |
| Priya Nair (team lead) | only her own team (4 people), read-only switches, no change log and no "Manage a user" |
| Daniel Okafor (member) | a message that he does not have `usage:read`, nothing else |

Choosing the period "September 2026 (partial)" shows a notice that the data stops on 28 September.

As the admin, "Manage a user" lets you override a capability for one person or suspend and restore them. Each action goes into the change log.

---

## 9. Inside the assistant (Claude Code)

```bash
claude --mcp-config build/local/mcp-lead.json --strict-mcp-config
```

Inside Claude Code, `/mcp` should show `meridian-usage` as connected. Then ask, one at a time:

1. `How much did my team use in 2026-08?`
   Answers: clinical-operations, about 16.6M tokens, $145.95 (Claude $132.64, Gemini $13.32).
2. `What did the Finance team use in 2026-08?`
   Refuses: a team lead can only see their own team.
3. `Turn off web-search for my team.`
   Refuses: changing settings needs the write scope, which only platform admins have.

Use an explicit month in the questions. "Last month" is ambiguous here because September is only partly covered by the data.

The wording of the answers varies between runs. The numbers and the allow-or-refuse outcome do not. Type `/exit` to leave.

The same connector as the admin:

```bash
node -e "const c=require('./build/local/prod/claude-desktop.json').mcpServers['meridian-usage']; c.env.MERIDIAN_USER='chloe.dubois@meridianls.example'; require('fs').writeFileSync('build/local/mcp-admin.json', JSON.stringify({mcpServers:{'meridian-usage':c}}))"
claude --mcp-config build/local/mcp-admin.json --strict-mcp-config
```

Asking `What did the Finance team use in 2026-08?` now returns an answer (1,767,674 tokens, $11.29).

---

## 10. Three environments from one command

```bash
npm run --silent render -- --check
```

Expected: `dist/ matches a fresh render`

```bash
grep -A4 '"capabilities:write"' dist/dev/permissions.json dist/prod/permissions.json | grep -E "roles|platform|team_lead|member"
```

Expected: in dev both `platform_admin` and `team_lead` can change settings; in prod only `platform_admin`.

The committed config cannot be edited by hand without CI noticing:

```bash
node -e "const fs=require('fs');const p='dist/prod/permissions.json';const m=JSON.parse(fs.readFileSync(p));m.scopes['capabilities:write'].roles.push('team_lead');fs.writeFileSync(p,JSON.stringify(m,null,2))"
npm run --silent render -- --check
```

Expected: `dist/ is out of date or hand-edited` and `differs: .../dist/prod/permissions.json`. Restoring it:

```bash
npm run --silent render
npm run --silent render -- --check
```

Expected: `rendered dev, staging, prod ... validation passed`, then `dist/ matches a fresh render`.

---

## 11. Tests and CI

```bash
git log --oneline | tail -14
```

Expected: for each part of the project, a `test:` commit followed by the `feat:` commit that makes it pass.

```bash
gh run list --repo pushpendra20mishra/meridian-usage-connector --limit 1
```

Expected: one run, `completed success`. The Actions tab on GitHub shows the three jobs green.

The full suite can also be run locally (about a minute):

```bash
make ci
```

Expected: `dist/ matches a fresh render`, `Test Files 18 passed`, and all tests passed with none failed.
