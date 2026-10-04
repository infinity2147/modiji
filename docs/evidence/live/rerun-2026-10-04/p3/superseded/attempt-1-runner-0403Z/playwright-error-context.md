# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: p3-gate.live.spec.ts >> @live @p3 run A: expert types a note while talking
- Location: e2e/live/p3-gate.live.spec.ts:45:1

# Error details

```
Error: interlock dialog on Save: Approval requiredEscalate to compliance officer for NS-2026-0103 can only be committed with an acknowledgement or an escalation. Both are recorded with your note.Matched rulesrule_0db2a2b89d2203Expert evidence“Never approve a politically exposed person without compliance sign-off.”Expert, spoken · 0:55.4–1:00.1 · supports the ruleNote (required)CancelEscalateAcknowledge and commitClose
```

# Page snapshot

```yaml
- generic:
  - generic:
    - banner [aria-hidden]:
      - generic:
        - generic: Northstar Bank
        - heading [level=1]: CaseDesk
      - generic: Synthetic data — fictional policy
      - generic:
        - paragraph: "Sensing (disclosed): DOM events · typing & scroll timing · microphone only when voice is on"
        - paragraph:
          - generic: Expert capture
          - generic [aria-hidden]: ·
          - generic: Training set
          - generic [aria-hidden]: ·
          - generic: 2bbcae60
        - link:
          - /url: /sandbox
          - text: New session
    - generic:
      - generic [aria-hidden]:
        - region:
          - generic:
            - generic:
              - heading [level=2]: Case queue
              - paragraph: 2 of 3 decided
            - progressbar
          - list:
            - listitem:
              - button:
                - generic:
                  - generic: NS-2026-0101
                  - generic: Decided
                - generic: Halvorsen Marine Logistics Ltd
                - generic:
                  - generic: Company
                  - generic [aria-hidden]: ·
                  - generic: Estoria
                  - generic: Medium risk
                - generic: "Outcome: Send to enhanced review"
            - listitem:
              - button:
                - generic:
                  - generic: NS-2026-0102
                  - generic: Decided
                - generic: Quillfeather Agritrade Holdings
                - generic:
                  - generic: Company
                  - generic [aria-hidden]: ·
                  - generic: Galvania
                  - generic: High risk
                - generic: "Outcome: Approve onboarding"
            - listitem:
              - button:
                - generic:
                  - generic: NS-2026-0103
                  - generic: Open
                - generic: Valentin Ashgrove
                - generic:
                  - generic: Individual
                  - generic [aria-hidden]: ·
                  - generic: Aldermere
                  - generic: Low risk
      - main [aria-hidden]:
        - article:
          - generic:
            - generic:
              - paragraph: NS-2026-0103
              - heading [level=2]: Valentin Ashgrove
            - paragraph:
              - text: Submitted
              - time: 16 Sept 2026
          - generic:
            - region:
              - generic:
                - heading [level=3]: Customer
              - generic:
                - generic:
                  - term: Name
                  - definition: Valentin Ashgrove
                  - term: Entity type
                  - definition: Individual
                  - term: Registration no.
                  - definition: ALD-P615042
                  - term: Country
                  - definition:
                    - generic:
                      - text: Aldermere
                      - generic: Low risk
                  - term: Address
                  - definition: 27 Cedar Court, Port Elsby, Aldermere
            - region:
              - generic:
                - heading [level=3]: Relationship
              - generic:
                - generic:
                  - term: Customer status
                  - definition:
                    - generic: New customer
                  - term: Relationship age
                  - definition: New relationship
                  - term: Relationship manager
                  - definition: Signe Valcourt
          - region:
            - generic:
              - heading [level=3]: Beneficial owners
            - generic:
              - generic:
                - table:
                  - rowgroup:
                    - row:
                      - columnheader: Name
                      - columnheader: Role
                      - columnheader: Share
                      - columnheader: ID verified
                      - columnheader: PEP
                  - rowgroup:
                    - row:
                      - cell: Valentin Ashgrove
                      - cell: Account holder
                      - cell: 100 %
                      - cell:
                        - generic: Verified
                      - cell:
                        - generic: "Yes"
          - generic:
            - region:
              - generic:
                - heading [level=3]: Screening
              - generic:
                - generic:
                  - term: Sanctions
                  - definition:
                    - generic:
                      - generic: Clear
                      - generic: No match on the Northstar Synthetic Sanctions List.
                  - term: Adverse media
                  - definition:
                    - generic:
                      - generic: None
                      - generic: No relevant adverse media found.
            - region:
              - generic:
                - heading [level=3]: Source of funds
              - generic:
                - generic:
                  - term: Status
                  - definition:
                    - generic: Verified
                  - term: Description
                  - definition: Salary as deputy minister of transport (fictional) and savings; payslips and bank statements reviewed.
                  - term: Expected monthly volume
                  - definition: €9,500
          - region:
            - generic:
              - heading [level=3]: Documents
            - generic:
              - list:
                - listitem:
                  - generic: Passport — Valentin Ashgrove
                  - generic: Received
                - listitem:
                  - generic: Proof of address
                  - generic: Received
                - listitem:
                  - generic: Source-of-funds statement
                  - generic: Received
      - generic:
        - region "Voice · Interviewer agent":
          - generic [aria-hidden]:
            - heading [level=2]: Voice · Interviewer agent
            - status:
              - generic: Connected
          - generic:
            - button [aria-hidden]:
              - text: Go off the record
              - generic: Alt+Shift+O
            - button [aria-hidden]: End conversation
            - list [aria-hidden]:
              - listitem: Microphone live — sent to the voice provider
              - listitem: Agent silent
            - status [aria-hidden]: “Analyst risk rating” is not on screen
            - region "Transcript":
              - heading [level=3] [aria-hidden]: Transcript
              - log:
                - listitem:
                  - generic: "Expert:"
                  - text: Let me jot down the ownership details while I read through this file.
                - listitem:
                  - generic: "Agent:"
                  - text: What led you to send this to enhanced review? What would have changed your mind?
                - listitem:
                  - generic: "Expert:"
                  - text: The largest owner holds 35% and isn't verified. Anything over 25% that isn't verified goes to enhanced review.
                - listitem:
                  - generic: "Agent:"
                  - text: If the entity type were "individual" instead of company, with the largest beneficial owner share still at 100%, what would you decide?
                - listitem:
                  - generic: "Expert:"
                  - text: If the largest owner holds more than 25% and isn't verified, it goes to enhanced review.
                - listitem:
                  - generic: "Expert:"
                  - text: Let me jot down the ownership details while I read through this file.
                - listitem:
                  - generic: "Agent:"
                  - text: What made you decide to approve onboarding here, and what would have changed your mind?
                - listitem:
                  - generic: "Expert:"
                  - text: They've banked with us for three years, and their source of funds is verified, so the high-risk country on its own doesn't send them to enhanced review.
                - listitem:
                  - generic: "Agent:"
                  - text: If the analyst risk rating were "medium" instead of high, what would you decide?
                - listitem:
                  - generic: "Expert:"
                  - text: They've banked with us for three years, and their source of funds is verified, so the high-risk country on its own doesn't send them to enhanced review. Let me jot down the ownership details while I read through this file.
        - region [aria-hidden]:
          - generic:
            - heading [level=2]: Review
            - generic: NS-2026-0103
          - generic:
            - generic:
              - generic:
                - generic: Risk rating
                - combobox:
                  - generic: High
                - combobox [aria-hidden]
              - group:
                - generic: Outcome
                - radiogroup:
                  - generic:
                    - radio
                    - radio [aria-hidden]
                    - text: Approve onboarding
                  - generic:
                    - radio
                    - radio [aria-hidden]
                    - text: Send to enhanced review
                  - generic:
                    - radio
                    - radio [aria-hidden]
                    - text: Request documents
                  - generic:
                    - radio [checked]
                    - radio [checked] [aria-hidden]
                    - text: Escalate to compliance officer
                  - generic:
                    - radio
                    - radio [aria-hidden]
                    - text: Reject
            - generic:
              - button: Save decision
              - paragraph: Save runs the deterministic interlock against the confirmed rulebook before anything is committed.
        - status: All DOM events delivered
        - region [aria-hidden]:
          - generic:
            - heading [level=2]: Screen capture
            - status:
              - generic: Capturing
          - generic:
            - paragraph: "Screen frames: change-detected, best-effort PII blur in your browser before upload."
            - button: Stop sharing
            - paragraph: "Vision: 2 events from 2 frames · p95 frame→event 7760 ms"
            - group:
              - generic: Perception stats
      - generic [aria-hidden]:
        - generic:
          - generic:
            - generic:
              - region:
                - status: WAITING
                - list:
                  - listitem:
                    - generic: Typing
                    - generic: ✓
                  - listitem:
                    - generic: Speaking
                    - generic: ✓
                  - listitem:
                    - generic: Screen moving
                    - generic: ✓
                - generic:
                  - generic: Question value
                  - generic: "0.60"
                - paragraph: "Reason: waiting: Breakpoint"
            - generic:
              - button: Concepts 0
            - button: Engineering view
          - generic:
            - region:
              - generic:
                - heading [level=2]:
                  - text: Event ticker
                  - generic: · live ledger
              - log:
                - listitem:
                  - time: 09:34:42
                  - generic: engine
                  - generic: Agent turn skipped (Not control message)
                - listitem:
                  - time: 09:34:46
                  - generic: engine
                  - generic: Agent turn skipped (Not control message)
                - listitem:
                  - time: 09:34:47
                  - generic: voice
                  - generic: "Expert: “The largest owner holds 35% and isn't verified. Anything over 25% that isn't verified goe…”"
                - listitem:
                  - time: 09:34:52
                  - generic: engine
                  - generic: Gate authorized · “If the entity type were "individual" instead of company, with the lar…” · 0 ms after valid
                - listitem:
                  - time: 09:34:53
                  - generic: control
                  - generic: Control message
                - listitem:
                  - time: 09:34:53
                  - generic: engine
                  - generic: Agent asks · “If the entity type were "individual" instead of company, with the lar…”
                - listitem:
                  - time: 09:34:55
                  - generic: engine
                  - generic: Answer parsed · 0 hypothesis(es) eliminated · 1 rule(s) stated · 0 new concept(s)
                - listitem:
                  - time: 09:34:55
                  - generic: engine
                  - generic: Rule confirmed
                - listitem:
                  - time: 09:34:55
                  - generic: engine
                  - generic: "Hypotheses updated · reviewOutcome · top: if largest beneficial owner share above 25% and largest owner identity verified is no then enhancedReview (0.16)"
                - listitem:
                  - time: 09:34:56
                  - generic: engine
                  - generic: "Agent: “If the entity type were \"individual\" instead of company, with the largest beneficial owne…”"
                - listitem:
                  - time: 09:34:59
                  - generic: engine
                  - generic: Question dropped (Superseded) · “If the analyst risk rating were "low" instead of medium, what would y…”
                - listitem:
                  - time: 09:34:59
                  - generic: engine
                  - generic: Question queued · competing explanations · EIG 0.83 bits · “If the largest owner's identity were verified, so "yes" instead of no…”
                - listitem:
                  - time: 09:34:59
                  - generic: engine
                  - generic: Question queued · competing explanations · EIG 0.77 bits · “If the largest beneficial owner share were 10% instead of 35%, what w…”
                - listitem:
                  - time: 09:34:59
                  - generic: engine
                  - generic: Question queued · competing explanations · EIG 0.61 bits · “If the entity type were "trust" rather than company, what would your …”
                - listitem:
                  - time: 09:35:08
                  - generic: engine
                  - generic: Agent turn skipped (Not control message)
                - listitem:
                  - time: 09:35:08
                  - generic: voice
                  - generic: "Expert: “If the largest owner holds more than 25% and isn't verified, it goes to enhanced review.”"
                - listitem:
                  - time: 09:35:09
                  - generic: dom
                  - generic: Opened case · NS-2026-0102
                - listitem:
                  - time: 09:35:09
                  - generic: client
                  - generic: "Frame #3 received · 0 region(s) redacted"
                - listitem:
                  - time: 09:35:13
                  - generic: engine
                  - generic: Agent turn skipped (Not control message)
                - listitem:
                  - time: 09:35:13
                  - generic: voice
                  - generic: "Expert: “Let me jot down the ownership details while I read through this file.”"
                - listitem:
                  - time: 09:35:13
                  - generic: dom
                  - generic: "Analyst risk rating changed: Unrated→High · NS-2026-0102"
                - listitem:
                  - time: 09:35:14
                  - generic: engine
                  - generic: Interlock check · Approve onboarding · NS-2026-0102 → Allow
                - listitem:
                  - time: 09:35:14
                  - generic: dom
                  - generic: "Decision saved: Approve onboarding · NS-2026-0102"
                - listitem:
                  - time: 09:35:18
                  - generic: engine
                  - generic: "Hypotheses updated · reviewOutcome · top: if largest beneficial owner share above 25% and largest owner identity verified is no then enhancedReview (0.29) · surprise 1.20 bits"
                - listitem:
                  - time: 09:35:20
                  - generic: dom
                  - generic: "Action: Approve onboarding · NS-2026-0102"
                - listitem:
                  - time: 09:35:22
                  - generic: engine
                  - generic: Question dropped (Superseded) · “If the largest owner's identity were verified, so "yes" instead of no…”
                - listitem:
                  - time: 09:35:22
                  - generic: engine
                  - generic: Question dropped (Superseded) · “If the largest beneficial owner share were 10% instead of 35%, what w…”
                - listitem:
                  - time: 09:35:22
                  - generic: engine
                  - generic: Question dropped (Superseded) · “If the country risk were "high" instead of medium, what would you dec…”
                - listitem:
                  - time: 09:35:22
                  - generic: engine
                  - generic: Question dropped (Superseded) · “If source of funds were "not provided" instead of verified, what woul…”
                - listitem:
                  - time: 09:35:22
                  - generic: engine
                  - generic: Question dropped (Superseded) · “If the entity type were "trust" rather than company, what would your …”
                - listitem:
                  - time: 09:35:22
                  - generic: engine
                  - generic: Question queued · unexplained decision · EIG 1.20 bits · “What made you decide to approve onboarding here, and what would have …”
                - listitem:
                  - time: 09:35:22
                  - generic: engine
                  - generic: Question queued · competing explanations · EIG 0.60 bits · “If the analyst risk rating were "medium" instead of high, what would …”
                - listitem:
                  - time: 09:35:22
                  - generic: engine
                  - generic: Question queued · competing explanations · EIG 0.60 bits · “If the country risk were "medium" instead of high, what would you dec…”
                - listitem:
                  - time: 09:35:22
                  - generic: engine
                  - generic: Question queued · competing explanations · EIG 0.60 bits · “If this customer were "new" instead of existing, with a relationship …”
                - listitem:
                  - time: 09:35:22
                  - generic: engine
                  - generic: Question queued · competing explanations · EIG 0.60 bits · “Suppose the relationship age were 0 months instead of 36, with the cu…”
                - listitem:
                  - time: 09:35:26
                  - generic: engine
                  - generic: Gate authorized · “What made you decide to approve onboarding here, and what would have …” · 0 ms after valid
                - listitem:
                  - time: 09:35:26
                  - generic: control
                  - generic: Control message
                - listitem:
                  - time: 09:35:26
                  - generic: engine
                  - generic: Agent asks · “What made you decide to approve onboarding here, and what would have …”
                - listitem:
                  - time: 09:35:28
                  - generic: engine
                  - generic: Answer parsed · 0 hypothesis(es) eliminated · 1 rule(s) stated · 0 new concept(s)
                - listitem:
                  - time: 09:35:28
                  - generic: engine
                  - generic: Rule revised
                - listitem:
                  - time: 09:35:28
                  - generic: engine
                  - generic: "Hypotheses updated · reviewOutcome · top: if largest beneficial owner share above 25% and largest owner identity verified is no then enhancedReview (0.29)"
                - listitem:
                  - time: 09:35:28
                  - generic: engine
                  - generic: "Agent: “What made you decide to approve onboarding here, and what would have changed your mind?”"
                - listitem:
                  - time: 09:35:29
                  - generic: engine
                  - generic: Question queued · competing explanations · EIG 0.38 bits · “If the largest owner's identity were not verified, so "no" instead of…”
                - listitem:
                  - time: 09:35:43
                  - generic: engine
                  - generic: Agent turn skipped (Not control message)
                - listitem:
                  - time: 09:35:43
                  - generic: voice
                  - generic: "Expert: “They've banked with us for three years, and their source of funds is verified, so the hig…”"
                - listitem:
                  - time: 09:35:47
                  - generic: engine
                  - generic: Gate authorized · “If the analyst risk rating were "medium" instead of high, what would …” · 10 ms after valid
                - listitem:
                  - time: 09:35:50
                  - generic: control
                  - generic: Control message
                - listitem:
                  - time: 09:35:51
                  - generic: engine
                  - generic: Agent asks · “If the analyst risk rating were "medium" instead of high, what would …”
                - listitem:
                  - time: 09:35:53
                  - generic: engine
                  - generic: "Agent: “If the analyst risk rating were \"medium\" instead of high, what would you decide?”"
                - listitem:
                  - time: 09:35:57
                  - generic: engine
                  - generic: Answer parsed · 0 hypothesis(es) eliminated · 1 rule(s) stated · 0 new concept(s)
                - listitem:
                  - time: 09:35:57
                  - generic: engine
                  - generic: Rule confirmed
                - listitem:
                  - time: 09:35:57
                  - generic: engine
                  - generic: "Hypotheses updated · reviewOutcome · top: if largest beneficial owner share above 25% and largest owner identity verified is no then enhancedReview (0.29)"
                - listitem:
                  - time: 09:36:01
                  - generic: engine
                  - generic: Agent turn skipped (Not control message)
                - listitem:
                  - time: 09:36:04
                  - generic: engine
                  - generic: Question queued · competing explanations · EIG 0.40 bits · “If the analyst risk rating were unrated instead of high, what would y…”
                - listitem:
                  - time: 09:36:04
                  - generic: dom
                  - generic: Opened case · NS-2026-0103
                - listitem:
                  - time: 09:36:06
                  - generic: engine
                  - generic: Agent turn skipped (Not control message)
                - listitem:
                  - time: 09:36:08
                  - generic: dom
                  - generic: "Analyst risk rating changed: Unrated→High · NS-2026-0103"
                - listitem:
                  - time: 09:36:09
                  - generic: engine
                  - generic: Interlock check · Escalate to compliance officer · NS-2026-0103 → Needs approval
                - listitem:
                  - time: 09:36:09
                  - generic: engine
                  - generic: Agent turn skipped (Not control message)
                - listitem:
                  - time: 09:36:10
                  - generic: voice
                  - generic: "Expert: “They've banked with us for three years, and their source of funds is verified, so the hig…”"
          - region:
            - heading [level=2]: Compliance · computed from the ledger
            - list:
              - listitem:
                - generic: Live questions
                - generic: 4/3
              - listitem:
                - generic: Guardrail
                - generic: ✗
              - listitem:
                - generic: Debrief gaps closed
                - generic: 0/3
              - listitem:
                - generic: Teach-back
                - generic: ✗
              - listitem:
                - generic: Unseen case intercepted
                - generic: ✗
  - alert
  - dialog [ref=e2]:
    - generic [ref=e3]:
      - heading "Approval required" [level=2] [ref=e4]
      - paragraph [ref=e7]:
        - strong [ref=e8]: Escalate to compliance officer
        - text: for NS-2026-0103 can only be committed with an acknowledgement or an escalation. Both are recorded with your note.
    - generic [ref=e9]:
      - region [ref=e10]:
        - heading "Matched rules" [level=3] [ref=e11]
        - list [ref=e12]:
          - listitem [ref=e13]: rule_0db2a2b89d2203
      - region [ref=e14]:
        - heading "Expert evidence" [level=3] [ref=e15]
        - figure [ref=e17]:
          - blockquote [ref=e18]:
            - paragraph [ref=e22]: “Never approve a politically exposed person without compliance sign-off.”
          - generic [ref=e23]:
            - text: Expert, spoken ·
            - time [ref=e24]: 0:55.4–1:00.1
            - text: · supports the rule
    - generic [ref=e25]:
      - generic [ref=e26]:
        - generic [ref=e27]: Note (required)
        - textbox "Note (required)" [active] [ref=e28]:
          - /placeholder: Why you are committing anyway, or what the reviewer should check
      - generic [ref=e29]:
        - button "Cancel" [ref=e30]
        - button "Escalate" [disabled]
        - button "Acknowledge and commit" [disabled]
    - button "Close" [ref=e31]
```

# Test source

```ts
  46  |   constructor(page: Page, request: APIRequestContext) {
  47  |     this.page = page;
  48  |     this.request = request;
  49  |   }
  50  | 
  51  |   static async open(page: Page, request: APIRequestContext): Promise<Expert> {
  52  |     await page.addInitScript(installHarness, { agentRmsThreshold: 0.008, agentSilenceMs: 1000 });
  53  |     return new Expert(page, request);
  54  |   }
  55  | 
  56  |   async events(): Promise<HarnessEvent[]> {
  57  |     return this.page.evaluate(() => (window as unknown as W).__live.events);
  58  |   }
  59  | 
  60  |   async mark(label: string, data: Record<string, unknown> = {}): Promise<void> {
  61  |     await this.page.evaluate(([l, d]) => (window as unknown as W).__live.mark(l, d), [label, data] as const);
  62  |   }
  63  | 
  64  |   async startSession(set: "Training" | "Practice" | "Held-out" = "Training"): Promise<string> {
  65  |     await this.page.goto("/sandbox");
  66  |     await this.page.getByRole("radio", { name: /^Expert capture/ }).click();
  67  |     await this.page.getByRole("radio", { name: new RegExp(`^${set}`) }).click();
  68  |     await this.page.getByRole("button", { name: "Start session" }).click();
  69  |     await expect(this.page).toHaveURL(/session=/, { timeout: 30_000 });
  70  |     this.sessionId = new URL(this.page.url()).searchParams.get("session") ?? "";
  71  |     await expect(this.queue().first()).toBeVisible({ timeout: 30_000 });
  72  |     return this.sessionId;
  73  |   }
  74  | 
  75  |   queue() {
  76  |     return this.page.getByRole("list", { name: "Cases" }).getByRole("button");
  77  |   }
  78  | 
  79  |   async shareScreen(): Promise<void> {
  80  |     const card = this.page.getByRole("region", { name: "Screen capture" });
  81  |     await card.getByRole("button", { name: "Share screen" }).click();
  82  |     await expect(card.getByRole("status", { name: "Screen capture status" })).toHaveText("Capturing", { timeout: 30_000 });
  83  |   }
  84  | 
  85  |   async startInterview(): Promise<string> {
  86  |     await this.page.getByRole("button", { name: "Start interview" }).click();
  87  |     await expect(this.page.getByRole("status", { name: "Voice status" })).toHaveText("Connected", { timeout: 45_000 });
  88  |     await expect.poll(async () => (await this.events()).some((e) => e.type === "remote_audio_track"), { timeout: 30_000 }).toBe(true);
  89  |     const response = (await this.events()).find((e) => e.type === "fetch_voice_token");
  90  |     void response;
  91  |     return this.conversationId;
  92  |   }
  93  | 
  94  |   /** Reconnects if the conversation ended (e.g. the provider closed it); returns true if it had to. */
  95  |   async ensureConnected(): Promise<boolean> {
  96  |     const status = (await this.page.getByRole("status", { name: "Voice status" }).textContent()) ?? "";
  97  |     if (status.includes("Connected")) return false;
  98  |     await this.mark("reconnect", { status });
  99  |     await this.page.getByRole("button", { name: "Start interview" }).click();
  100 |     await expect(this.page.getByRole("status", { name: "Voice status" })).toHaveText("Connected", { timeout: 45_000 });
  101 |     await this.page.waitForTimeout(1500);
  102 |     return true;
  103 |   }
  104 | 
  105 |   async endInterview(): Promise<void> {
  106 |     const end = this.page.getByRole("button", { name: "End conversation" });
  107 |     if (await end.isVisible()) await end.click();
  108 |   }
  109 | 
  110 |   async screen(lines: string[], offset = 0): Promise<void> {
  111 |     await this.page.evaluate(([l, o]) => (window as unknown as W).__live.screen(l, o), [lines, offset] as const);
  112 |   }
  113 | 
  114 |   async openCase(index: number): Promise<string> {
  115 |     const item = this.queue().nth(index);
  116 |     const text = (await item.textContent()) ?? "";
  117 |     const caseId = /NS-\d{4}-\d{4}/.exec(text)?.[0] ?? `#${index}`;
  118 |     await item.click();
  119 |     await expect(this.page.getByRole("article")).toContainText(caseId);
  120 |     await this.screen([`Case ${caseId}`, "Customer · Relationship · Beneficial owners", "Screening · Source of funds · Documents", "Risk rating: unrated"]);
  121 |     await this.mark("open_case", { caseId });
  122 |     return caseId;
  123 |   }
  124 | 
  125 |   async rate(rating: Rating): Promise<void> {
  126 |     await this.page.getByRole("combobox", { name: "Risk rating" }).click();
  127 |     await this.page.getByRole("option", { name: RATING_LABEL[rating], exact: true }).click();
  128 |   }
  129 | 
  130 |   /** Rates with the keyboard only (focus the select, open it, arrow to the rating, Enter). */
  131 |   async rateByKeyboard(rating: Rating): Promise<void> {
  132 |     const trigger = this.page.getByRole("combobox", { name: "Risk rating" });
  133 |     await trigger.focus();
  134 |     await this.page.keyboard.press("Enter");
  135 |     await expect(this.page.getByRole("option", { name: RATING_LABEL[rating], exact: true })).toBeVisible();
  136 |     await this.page.getByRole("option", { name: RATING_LABEL[rating], exact: true }).focus();
  137 |     await this.page.keyboard.press("Enter");
  138 |   }
  139 | 
  140 |   async decide(outcome: Outcome): Promise<void> {
  141 |     await this.page.getByRole("radio", { name: OUTCOME_LABEL[outcome] }).click();
  142 |     await this.page.getByRole("button", { name: "Save decision" }).click();
  143 |     const committed = this.page.getByRole("status").filter({ hasText: "Decision committed" });
  144 |     const dialog = this.page.getByRole("dialog");
  145 |     await expect(committed.or(dialog).first()).toBeVisible({ timeout: 20_000 });
> 146 |     if (await dialog.isVisible()) throw new Error(`interlock dialog on Save: ${(await dialog.textContent())?.slice(0, 500)}`);
      |                                         ^ Error: interlock dialog on Save: Approval requiredEscalate to compliance officer for NS-2026-0103 can only be committed with an acknowledgement or an escalation. Both are recorded with your note.Matched rulesrule_0db2a2b89d2203Expert evidence“Never approve a politically exposed person without compliance sign-off.”Expert, spoken · 0:55.4–1:00.1 · supports the ruleNote (required)CancelEscalateAcknowledge and commitClose
  147 |     await this.mark("committed", { outcome });
  148 |   }
  149 | 
  150 |   /**
  151 |    * Real keystrokes in the case file area (the expert "typing a note"). CaseDesk has no free-text field
  152 |    * in Expert mode, so the TEST makes the case-file <main> focusable (tabindex=-1, test-side DOM
  153 |    * attribute only) and types there; the keystrokes reach the work area like typing in any field would.
  154 |    */
  155 |   async typeNote(text: string, delayMs = 70): Promise<{ start: number; end: number }> {
  156 |     const main = this.page.locator("main:has(article)");
  157 |     await main.evaluate((el) => el.setAttribute("tabindex", "-1"));
  158 |     await main.focus();
  159 |     const start = Date.now();
  160 |     await this.page.keyboard.type(text, { delay: delayMs });
  161 |     return { start, end: Date.now() };
  162 |   }
  163 | 
  164 |   async scrollCase(steps: number, deltaY: number, pauseMs: number): Promise<void> {
  165 |     await this.page.locator("main:has(article)").hover();
  166 |     for (let i = 0; i < steps; i += 1) {
  167 |       await this.page.mouse.wheel(0, i % 2 === 0 ? deltaY : -deltaY);
  168 |       await this.screen([`scrolling… ${i}`], (i % 5) * 40);
  169 |       await this.page.waitForTimeout(pauseMs);
  170 |     }
  171 |   }
  172 | 
  173 |   private async ensureLoaded(text: string): Promise<string> {
  174 |     const cached = this.loaded.get(text);
  175 |     if (cached !== undefined) return cached;
  176 |     const c = await clip(text);
  177 |     await this.page.evaluate(([k, b]) => (window as unknown as W).__live.load(k, b), [c.key, c.base64] as const);
  178 |     this.loaded.set(text, c.key);
  179 |     return c.key;
  180 |   }
  181 | 
  182 |   async preload(texts: readonly string[]): Promise<void> {
  183 |     for (const text of texts) await this.ensureLoaded(text);
  184 |   }
  185 | 
  186 |   /** Speaks `text` (synthetic voice input, ElevenLabs TTS) into the microphone and waits until it has played. */
  187 |   async say(text: string, label = "line", gain = 1): Promise<{ start: number; end: number }> {
  188 |     const key = await this.ensureLoaded(text);
  189 |     const window_ = await this.page.evaluate(([k, g, l]) => (window as unknown as W).__live.play(k, g, l), [key, gain, label] as const);
  190 |     this.spoken.push({ label, text, gain, ...window_ });
  191 |     return window_;
  192 |   }
  193 | 
  194 |   /** Starts speaking without waiting (to type or scroll while talking). */
  195 |   sayAsync(text: string, label = "line", gain = 1): Promise<{ start: number; end: number }> {
  196 |     return this.say(text, label, gain);
  197 |   }
  198 | 
  199 |   async noise(level: number): Promise<void> {
  200 |     await this.page.evaluate((l) => (window as unknown as W).__live.noise(l), level);
  201 |   }
  202 | 
  203 |   /**
  204 |    * Waits for the agent's next spoken turn after the current cursor: its audio onset, its end (1 s of
  205 |    * silence on the track, the SDK mode back to listening) and the agent_response text. Returns null on timeout (no question was asked).
  206 |    */
  207 |   async waitForAgentTurn(timeoutMs: number): Promise<{ start: number; end: number; text: string } | null> {
  208 |     const deadline = Date.now() + timeoutMs;
  209 |     /** Index of the turn's first audio onset in the page's event log (indices are stable: the log only grows). */
  210 |     let startIndex = -1;
  211 |     for (;;) {
  212 |       const events = await this.events();
  213 |       if (startIndex < 0) startIndex = events.findIndex((e, i) => i >= this.cursor && e.type === "agent_audio_start");
  214 |       const start = startIndex < 0 ? undefined : events[startIndex];
  215 |       if (start !== undefined) {
  216 |         const after = events.slice(startIndex);
  217 |         const audio = after.filter((e) => e.type === "agent_audio_start" || e.type === "agent_audio_end");
  218 |         const last = audio.at(-1);
  219 |         const response = events.slice(this.cursor).find((e) => e.type === "agent_response");
  220 |         const silent = after.filter((e) => e.type === "ui_agent_mode").at(-1)?.mode !== "speaking";
  221 |         if (last?.type === "agent_audio_end" && response !== undefined && silent) {
  222 |           this.cursor = events.lastIndexOf(last) + 1;
  223 |           return { start: start.t, end: last.t, text: typeof response.text === "string" ? response.text : "" };
  224 |         }
  225 |       }
  226 |       if (Date.now() > deadline) {
  227 |         if (start === undefined) return null;
  228 |         // Audio began but never settled: report what we have.
  229 |         const response = events.slice(this.cursor).find((e) => e.type === "agent_response");
  230 |         this.cursor = events.length;
  231 |         return { start: start.t, end: Date.now(), text: String(response?.text ?? "") };
  232 |       }
  233 |       await this.page.waitForTimeout(100);
  234 |     }
  235 |   }
  236 | 
  237 |   /** Moves the turn cursor to now (ignore agent turns before this point). */
  238 |   async resetCursor(): Promise<void> {
  239 |     this.cursor = (await this.events()).length;
  240 |   }
  241 | 
  242 |   async ledger(): Promise<Entry[]> {
  243 |     const out: Entry[] = [];
  244 |     let after: number | undefined;
  245 |     for (;;) {
  246 |       const response = await this.request.get(`/api/sessions/${this.sessionId}/ledger?limit=500${after === undefined ? "" : `&after=${after}`}`);
```