# Your team's AI usage, now available inside the assistant

**To:** Meridian team leads · **From:** Platform team

You asked to see how much your team uses the assistant without leaving it. You can now ask it directly.

## What you can ask

Just ask in plain words. Examples that work today:

- "How much did my team use last month?" (this means August, the last full month of data we hold)
- "What did we spend in week 36?" or "…over the last 7 days?"
- "Who on my team uses it most?" (top 10 by default, up to 25)
- "Which features are switched on for my team?" (chat web search, code execution, this connector)

You get tokens and cost in US dollars, with Claude and Gemini shown separately and added together.
The numbers come from the same Claude and Google Cloud usage records the platform owners use, so
the two views always agree. They refresh from the exports we load, not live, and the latest data
ends on 28 September 2026.

## What you can't do, and why

- **See another team.** You see your own group only. Asking about Finance or HR returns a plain
  "not permitted" and no numbers. This is enforced by the connector itself, so rephrasing the
  question or asking the assistant to "pretend" does not change the answer. It exists because
  usage can reveal who is working on what.
- **Change settings.** Switching features on or off for a group is limited to platform admins in
  production. You can read the current state but not edit it.
- **See usage for a month still in progress as if it were complete.** September is partial; the
  answer says so.
- **Use it at all if your group isn't enabled yet.** In production we are starting with Clinical
  Operations and IT Platform. Other groups get a clear "not enabled for your group" until we turn
  it on.

## How to ask for more

Email the platform team or raise a ticket with: your group, what you want to see (for example, "usage by person per week") and why. We will reply with one of three outcomes: done, done in a narrower form, or no with the reason. If you want
your group switched on, say so; an admin enables it and you can use it straight away.

If an answer looks wrong, send us the question and the time you asked it; we can replay it.
