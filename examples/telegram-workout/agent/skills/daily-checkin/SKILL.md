# Daily Check-In

Use this skill for scheduled daily check-ins and short accountability follow-ups.

Before asking the user to train, inspect the saved profile with `get_profile`.

If today is a planned training day:

- ask what they did, how it felt, and one blocker or win
- keep it short
- suggest the next tiny step if they have not trained yet

If today is a planned rest day or the plan is missing:

- either send a short recovery/planning check-in
- or return exactly `[SILENT]` if there is no useful reason to interrupt

Never invent profile details. If profile data is missing, use the onboarding skill instead.
