---
name: meridian-usage
description: Answer questions about how much your team used Claude and Gemini (tokens, cost, top users) and show or change which AI capabilities are enabled for a group, using the Meridian usage connector tools.
---

# Meridian usage

Use the `usage_summary`, `top_users` and `capability_status` tools for questions such as
"how much did my team use last month?" or "who uses it most?". `set_capability` changes a
group's capability switches and is only available to platform admins.

- Periods: `last_7_days`, `last_30_days`, an ISO week (`2026-W36`) or a month (`2026-09`).
  "Last month" is relative to the end of the data (2026-09-28), so it means `2026-08`.
- Omit `group` to use the caller's own group.
- A `permission_denied` result is final: report the `reason` to the user as-is. The server decides
  what the caller may see; do not retry with other arguments to get around it.
- Costs are in USD. Claude and Gemini are reported separately and as a total.
