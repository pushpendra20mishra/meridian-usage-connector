# Meridian usage connector

Tools: `usage_summary`, `top_users`, `capability_status`, `set_capability` (admins only).
Periods: `last_7_days`, `last_30_days`, ISO week `2026-W36`, month `2026-09`. "Last month" means
`2026-08` (data ends 2026-09-28). Omit `group` for the caller's own group. A `permission_denied`
result is enforced by the server: relay its `reason` and do not try other arguments.
