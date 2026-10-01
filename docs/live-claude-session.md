# Live Claude session (Claude Code 2.1.286, prod environment, all-Node build)

Real model driving the connector over stdio: `claude -p ... --mcp-config build/local/mcp-<user>.json --strict-mcp-config --allowedTools "mcp__meridian-usage__*"`.
The host config, not the prompt, decides who the server runs as. Output below is verbatim.

## Team lead (priya.nair, Clinical Operations)

Prompt: Using only the meridian-usage tools: 1) How much did my team use last month? 2) How much did the Finance team use last month? 3) Turn off web-search for my team. Report each result in one line.

1. Your team (clinical-operations) used 11.6M tokens for $77.67 in September 2026. Claude was 5.07M tokens and $67.95, and Gemini was 6.53M tokens and $9.72. Data ends 2026-09-28, so the month is partial.
2. Finance usage was denied. Your team-lead role can only read clinical-operations.
3. Web-search is still on for your team. Turning it off needs the `capabilities:write` scope, which only platform admins have, and the call was denied. A platform admin would need to make this change.

Note: asked for "last month" the model may choose 2026-09 (partial) rather than 2026-08. The period description states the data window and the last full month, and the model flags a partial month, but the choice is the model's. The team-lead note says "last month" means August.

## Platform admin (chloe.dubois)

Prompt: Using only the meridian-usage tools: 1) Who are the top 3 users in Finance for 2026-08? 2) Is usage-connector enabled for Finance? 3) Enable it for Finance and confirm the new state, including who changed it. One line each.

1. Top 3 Finance users for 2026-08: Sofia Rossi (1,298,442 tokens, $9.93), Hannah Fischer (432,003 tokens, $1.19), Ravi Iyer (37,229 tokens, $0.17).
2. usage-connector was disabled for Finance. It was last updated 2026-10-01T11:58:09Z by chloe.dubois@meridianls.example.
3. The set call returned usage-connector enabled for Finance, updated 2026-10-01T11:58:27Z by chloe.dubois@meridianls.example. I didn't re-query status; this is the set call's own response.
