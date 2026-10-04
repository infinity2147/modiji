# Expert cue card: make the rules yourself

Production starts with an **empty rulebook on purpose**. A confirmed rule must carry the expert's exact words, a timestamp, and a screen frame, and the system will not let an admin enter rules in an expert's name. So the rules in the demo are yours, in your words, and the Work Map's quote trail proves it. This card only saves you thinking time.

The policy below is the fictional **Northstar Bank Synthetic Review Policy**. Say so in the demo ("synthetic data, fictional policy").

## 1. One-time setup (about 2 minutes)

1. Sign up at `/signup` with **your own username** (lowercase letters, digits, hyphens; not `24b4530`). Use a password of 10+ characters.
2. Sign out, then sign in as the admin `24b4530` and open **`/admin`**. Grant your new account the **expert** role.
3. Sign out and sign back in as **your expert account**.

## 2. Run the capture (about 4 minutes)

1. `/sandbox` → **Expert capture**, **Training** set, your name, language English (or Hindi). **Start session.**
2. **Share your screen** (required: every rule needs a real frame). Then start the interview.
3. Work the first three training cases (the core demo). Pick these outcomes; they are consistent with the policy:

| Case | What you see | Outcome to choose |
|---|---|---|
| NS-2026-0101 | Company, **medium-risk** country, largest owner holds **35%**, not verified | **Send to enhanced review** |
| NS-2026-0102 | Company, **high-risk** country, owner holds **20%**, existing customer of 36 months, funds verified | **Approve onboarding** |
| NS-2026-0103 | Individual, **politically exposed person**, low-risk country | **Escalate to compliance officer** |

When the agent asks "why", answer in a sentence or two. Short and direct works best.

4. Optional, if you have time: the training queue also holds five **judgment cases**. The screen shows the evidence (sector and its tier, declared turnover against expected activity, who stands behind each owner, name similarity, how serious the media is) but not what to do with it. That part is your reasoning, so say it when asked "why":

| Case | What you see | Outcome to choose |
|---|---|---|
| NS-2026-0104 | Laundrette company, **cash-intensive retail (high-risk sector)**, existing customer of only **8 months**, EUR 38,000 a month | **Send to enhanced review** |
| NS-2026-0105 | Cash-and-carry wholesaler, same high-risk sector, but existing for **41 months**, funds verified, activity in line with its declared turnover | **Approve onboarding** |
| NS-2026-0106 | Company whose largest shareholder (60%) is a **nominee** for an undisclosed party; nominator declaration missing | **Request documents** |
| NS-2026-0107 | Individual, sanctions list clear, but a **strong name similarity** (date of birth and nationality also match) | **Escalate to compliance officer** |
| NS-2026-0108 | Company in a **low-risk** country, clean file, but the majority owner is named in reports on a **bribery prosecution** (serious adverse media) | **Escalate to compliance officer** |

## 3. Add your rules (Debrief button, top bar)

Open **Debrief**. Confirm the engine's proposed rules that match what you believe, and use **Add a stop-rule** for the prohibitions. Say or type each one in your own words. These are suggestions; change the wording freely:

**Stop-rules (these block a commit and make the tutor intervene):**
- "Never approve a customer with a sanctions match; reject it."
- "A politically exposed person can only be approved with compliance sign-off."
- "Never approve a new customer from a high-risk country at desk level."

**Decision rules (the debrief will propose these; confirm the ones you agree with):**
- "A company whose largest owner holds more than 25 percent and isn't verified goes to enhanced review."
- "A politically exposed person gets escalated to the compliance officer."
- "If source of funds wasn't provided and expected monthly volume is 50,000 euros or more, request documents."

**Exception (this is the interesting one for the demo):**
- "An existing customer of at least two years with verified funds in a high-risk country can be approved without enhanced review."

**If you worked the judgment cases** (again, your words; these are only prompts):
- "A cash business expecting 25,000 euros a month or more goes to enhanced review, unless it has been with us at least a year, its funds are verified and its activity fits what it declared."
- "If a nominee holds shares, we ask for the nominator declaration first."
- "A strong name match never gets cleared at the desk; it goes to compliance."
- "Serious adverse media, like fraud or bribery, goes to compliance whatever the country."

## 4. What to show afterwards

- **Work Map** (top bar): each rule links to your exact quote, the screen frame and the ledger trace.
- **Tutor**: sign in as a trainee (or admin, which may run novice sessions), open the **held-out** set, and open **NS-2026-0201** (a *new* company in a *high-risk* country, owner 30% verified, a case you never saw). Choose **Approve**: the tutor intervenes before Save and cites your "never approve a new customer from a high-risk country" words. The held-out set has four more unseen cases, each a trap for a shortcut: NS-2026-0203 (an established cash business, but expecting about three times its declared turnover: request documents), NS-2026-0204 (every owner verified, but a holding company sits above the customer in a medium-risk country: enhanced review), NS-2026-0205 (only a weak name similarity in a low-risk country: approve) and NS-2026-0206 (six years with the bank, but a fraud prosecution: escalate). The tutor can only hold a trainee to the rules you confirmed, so it intervenes on these only if you taught the matching rule.
- **MCP**: an agent proposing "approve" on a covered case is blocked with your quote.

Everything above was said or typed by you, so say so. Don't claim the rules are real bank policy.
