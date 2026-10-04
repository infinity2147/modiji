# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: p3-gate.live.spec.ts >> @live @p3 run A: expert types a note while talking
- Location: e2e/live/p3-gate.live.spec.ts:45:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByRole('status').filter({ hasText: 'Decision committed' }).or(getByRole('dialog')).first()
Expected: visible
Timeout: 20000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" getByRole('status').filter({ hasText: 'Decision committed' }).or(getByRole('dialog')).first() with timeout 20000ms
  - waiting for getByRole('status').filter({ hasText: 'Decision committed' }).or(getByRole('dialog')).first()

```

```yaml
- alert
- banner:
  - text: Northstar Bank
  - heading "CaseDesk" [level=1]
  - text: Synthetic data — fictional policy
  - paragraph: "Sensing (disclosed): DOM events · typing & scroll timing · microphone only when voice is on"
  - paragraph: Expert capture Training set a2860d2f
  - link "New session":
    - /url: /sandbox
- region "Case queue":
  - heading "Case queue" [level=2]
  - paragraph: 0 of 3 decided
  - progressbar "Cases decided"
  - list "Cases":
    - listitem:
      - button "NS-2026-0101 Open Halvorsen Marine Logistics Ltd Company Estoria Medium risk"
    - listitem:
      - button "NS-2026-0102 Open Quillfeather Agritrade Holdings Company Galvania High risk"
    - listitem:
      - button "NS-2026-0103 Open Valentin Ashgrove Individual Aldermere Low risk"
- main:
  - article "Halvorsen Marine Logistics Ltd":
    - paragraph: NS-2026-0101
    - heading "Halvorsen Marine Logistics Ltd" [level=2]
    - paragraph:
      - text: Submitted
      - time: 14 Sept 2026
    - region "Customer":
      - heading "Customer" [level=3]
      - term: Name
      - definition: Halvorsen Marine Logistics Ltd
      - term: Entity type
      - definition: Company
      - term: Registration no.
      - definition: EST-C482913
      - term: Country
      - definition: Estoria Medium risk
      - term: Address
      - definition: 14 Quayside Row, Valmont, Estoria
    - region "Relationship":
      - heading "Relationship" [level=3]
      - term: Customer status
      - definition: New customer
      - term: Relationship age
      - definition: New relationship
      - term: Relationship manager
      - definition: Odile Brannock
    - region "Beneficial owners":
      - heading "Beneficial owners" [level=3]
      - table:
        - rowgroup:
          - row "Name Role Share ID verified PEP":
            - columnheader "Name"
            - columnheader "Role"
            - columnheader "Share"
            - columnheader "ID verified"
            - columnheader "PEP"
        - rowgroup:
          - row "Ingrid Halvorsen Director & shareholder 35 % Not verified No":
            - cell "Ingrid Halvorsen"
            - cell "Director & shareholder"
            - cell "35 %"
            - cell "Not verified"
            - cell "No"
          - row "Tomasz Okonkwo-Hale Shareholder 30 % Verified No":
            - cell "Tomasz Okonkwo-Hale"
            - cell "Shareholder"
            - cell "30 %"
            - cell "Verified"
            - cell "No"
          - row "Wanjiru Castellane Shareholder 20 % Verified No":
            - cell "Wanjiru Castellane"
            - cell "Shareholder"
            - cell "20 %"
            - cell "Verified"
            - cell "No"
    - region "Screening":
      - heading "Screening" [level=3]
      - term: Sanctions
      - definition: Clear No match on the Northstar Synthetic Sanctions List.
      - term: Adverse media
      - definition: None No relevant adverse media found.
    - region "Source of funds":
      - heading "Source of funds" [level=3]
      - term: Status
      - definition: Verified
      - term: Description
      - definition: Freight revenue; audited 2025 accounts and bank statements reviewed.
      - term: Expected monthly volume
      - definition: €18,000
    - region "Documents":
      - heading "Documents" [level=3]
      - list:
        - listitem: Company registry extract Received
        - listitem: Register of beneficial owners Received
        - listitem: Passport — Ingrid Halvorsen Missing
        - listitem: Source-of-funds statement Received
- region "Voice · Interviewer agent":
  - heading "Voice · Interviewer agent" [level=2]
  - status "Voice status": Connected
  - button "Go off the record Alt+Shift+O"
  - button "End conversation"
  - list "Sensing":
    - listitem: Microphone live — sent to the voice provider
    - listitem: Agent silent
  - region "Transcript":
    - heading "Transcript" [level=3]
    - log:
      - listitem: "Expert: Let me jot down the ownership details while I read through this file."
- region "Review":
  - heading "Review" [level=2]
  - text: NS-2026-0101 Risk rating
  - combobox "Risk rating": Medium
  - group "Outcome":
    - text: Outcome
    - radiogroup "Outcome":
      - radio "Approve onboarding"
      - text: Approve onboarding
      - radio "Send to enhanced review" [checked]
      - text: Send to enhanced review
      - radio "Request documents"
      - text: Request documents
      - radio "Escalate to compliance officer"
      - text: Escalate to compliance officer
      - radio "Reject"
      - text: Reject
  - alert:
    - text: Save failed — nothing was committed Request refused (502 http_502)
    - button "Retry"
  - button "Save decision"
  - paragraph: Save runs the deterministic interlock against the confirmed rulebook before anything is committed.
- status: 2 DOM events waiting — delivery retries on the next action
- region "Screen capture":
  - heading "Screen capture" [level=2]
  - status "Screen capture status": Capturing
  - paragraph: "Screen frames: change-detected, best-effort PII blur in your browser before upload."
  - button "Stop sharing"
  - paragraph: "Vision: 1 events from 1 frames · p95 frame→event 2858 ms"
  - group: Perception stats
- region "Speech gate":
  - 'status "Gate status: LISTENING"': LISTENING
  - list "Gate conditions":
    - 'listitem "Typing: clear"': Typing ✓
    - 'listitem "Speaking: clear"': Speaking ✓
    - 'listitem "Screen moving: clear"': Screen moving ✓
  - text: Question value —
  - paragraph: "Reason: no question queued"
- button "Concepts 0"
- button "Engineering view"
- region "Event ticker · live ledger":
  - heading "Event ticker · live ledger" [level=2]
  - log "Ledger events":
    - listitem:
      - time: 09:39:12
      - text: engine Session started · expert capture · training set
    - listitem:
      - time: 09:39:13
      - text: dom Navigated in CaseDesk
    - listitem:
      - time: 09:39:14
      - text: "client Frame #1 received · 0 region(s) redacted"
    - listitem:
      - time: 09:39:14
      - text: vision Navigated in CaseDesk
    - listitem:
      - time: 09:39:31
      - text: engine Agent turn skipped (Not control message)
    - listitem:
      - time: 09:39:19
      - text: "client Frame #2 received · 0 region(s) redacted"
    - listitem:
      - time: 09:39:32
      - text: engine Agent turn skipped (Not control message)
    - listitem:
      - time: 09:39:32
      - text: engine Agent turn skipped (Not control message)
    - listitem:
      - time: 09:39:32
      - text: "voice Expert: “Let me jot down the ownership details while I read through this file.”"
    - listitem:
      - time: 09:39:19
      - text: vision Opened case · NS-2026-0101
- region "Compliance · computed from the ledger":
  - heading "Compliance · computed from the ledger" [level=2]
  - list "Compliance":
    - 'listitem "Live questions: 0/3, pending"': Live questions 0/3
    - 'listitem "Guardrail: ✗, pending"': Guardrail ✗
    - 'listitem "Debrief gaps closed: 0/3, pending"': Debrief gaps closed 0/3
    - 'listitem "Teach-back: ✗, pending"': Teach-back ✗
    - 'listitem "Unseen case intercepted: ✗, pending"': Unseen case intercepted ✗
```

# Test source

```ts
  45  | 
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
> 145 |     await expect(committed.or(dialog).first()).toBeVisible({ timeout: 20_000 });
      |                                                ^ Error: expect(locator).toBeVisible() failed
  146 |     if (await dialog.isVisible()) {
  147 |       const text = (await dialog.textContent())?.slice(0, 500) ?? "";
  148 |       // The shared production rulebook holds "PEP → require_approval(compliance_officer)" (from the live P4
  149 |       // run), which applies to every outcome of the family. An expert who is escalating to the compliance
  150 |       // officer answers that interlock the way the product offers: a note and "Escalate". Anything else
  151 |       // is unexpected for the scripted plans and stops the run.
  152 |       if (outcome !== "escalateCompliance" || !/Approval required/.test(text)) throw new Error(`interlock dialog on Save: ${text}`);
  153 |       await dialog.getByLabel("Note (required)").click();
  154 |       await this.page.keyboard.type("Escalating to the compliance officer for sign-off.", { delay: 40 });
  155 |       await dialog.getByRole("button", { name: "Escalate", exact: true }).click();
  156 |       await expect(dialog).toBeHidden({ timeout: 20_000 });
  157 |       await this.mark("interlock_escalated", { outcome, dialog: text });
  158 |     }
  159 |     await this.mark("committed", { outcome });
  160 |   }
  161 | 
  162 |   /**
  163 |    * Real keystrokes in the case file area (the expert "typing a note"). CaseDesk has no free-text field
  164 |    * in Expert mode, so the TEST makes the case-file <main> focusable (tabindex=-1, test-side DOM
  165 |    * attribute only) and types there; the keystrokes reach the work area like typing in any field would.
  166 |    */
  167 |   async typeNote(text: string, delayMs = 70): Promise<{ start: number; end: number }> {
  168 |     const main = this.page.locator("main:has(article)");
  169 |     await main.evaluate((el) => el.setAttribute("tabindex", "-1"));
  170 |     await main.focus();
  171 |     const start = Date.now();
  172 |     await this.page.keyboard.type(text, { delay: delayMs });
  173 |     return { start, end: Date.now() };
  174 |   }
  175 | 
  176 |   async scrollCase(steps: number, deltaY: number, pauseMs: number): Promise<void> {
  177 |     await this.page.locator("main:has(article)").hover();
  178 |     for (let i = 0; i < steps; i += 1) {
  179 |       await this.page.mouse.wheel(0, i % 2 === 0 ? deltaY : -deltaY);
  180 |       await this.screen([`scrolling… ${i}`], (i % 5) * 40);
  181 |       await this.page.waitForTimeout(pauseMs);
  182 |     }
  183 |   }
  184 | 
  185 |   private async ensureLoaded(text: string): Promise<string> {
  186 |     const cached = this.loaded.get(text);
  187 |     if (cached !== undefined) return cached;
  188 |     const c = await clip(text);
  189 |     await this.page.evaluate(([k, b]) => (window as unknown as W).__live.load(k, b), [c.key, c.base64] as const);
  190 |     this.loaded.set(text, c.key);
  191 |     return c.key;
  192 |   }
  193 | 
  194 |   async preload(texts: readonly string[]): Promise<void> {
  195 |     for (const text of texts) await this.ensureLoaded(text);
  196 |   }
  197 | 
  198 |   /** Speaks `text` (synthetic voice input, ElevenLabs TTS) into the microphone and waits until it has played. */
  199 |   async say(text: string, label = "line", gain = 1): Promise<{ start: number; end: number }> {
  200 |     const key = await this.ensureLoaded(text);
  201 |     const window_ = await this.page.evaluate(([k, g, l]) => (window as unknown as W).__live.play(k, g, l), [key, gain, label] as const);
  202 |     this.spoken.push({ label, text, gain, ...window_ });
  203 |     return window_;
  204 |   }
  205 | 
  206 |   /** Starts speaking without waiting (to type or scroll while talking). */
  207 |   sayAsync(text: string, label = "line", gain = 1): Promise<{ start: number; end: number }> {
  208 |     return this.say(text, label, gain);
  209 |   }
  210 | 
  211 |   async noise(level: number): Promise<void> {
  212 |     await this.page.evaluate((l) => (window as unknown as W).__live.noise(l), level);
  213 |   }
  214 | 
  215 |   /**
  216 |    * Waits for the agent's next spoken turn after the current cursor: its audio onset, its end (1 s of
  217 |    * silence on the track, the SDK mode back to listening) and the agent_response text. Returns null on timeout (no question was asked).
  218 |    */
  219 |   async waitForAgentTurn(timeoutMs: number): Promise<{ start: number; end: number; text: string } | null> {
  220 |     const deadline = Date.now() + timeoutMs;
  221 |     /** Index of the turn's first audio onset in the page's event log (indices are stable: the log only grows). */
  222 |     let startIndex = -1;
  223 |     for (;;) {
  224 |       const events = await this.events();
  225 |       if (startIndex < 0) startIndex = events.findIndex((e, i) => i >= this.cursor && e.type === "agent_audio_start");
  226 |       const start = startIndex < 0 ? undefined : events[startIndex];
  227 |       if (start !== undefined) {
  228 |         const after = events.slice(startIndex);
  229 |         const audio = after.filter((e) => e.type === "agent_audio_start" || e.type === "agent_audio_end");
  230 |         const last = audio.at(-1);
  231 |         const response = events.slice(this.cursor).find((e) => e.type === "agent_response");
  232 |         const silent = after.filter((e) => e.type === "ui_agent_mode").at(-1)?.mode !== "speaking";
  233 |         if (last?.type === "agent_audio_end" && response !== undefined && silent) {
  234 |           this.cursor = events.lastIndexOf(last) + 1;
  235 |           return { start: start.t, end: last.t, text: typeof response.text === "string" ? response.text : "" };
  236 |         }
  237 |       }
  238 |       if (Date.now() > deadline) {
  239 |         if (start === undefined) return null;
  240 |         // Audio began but never settled: report what we have.
  241 |         const response = events.slice(this.cursor).find((e) => e.type === "agent_response");
  242 |         this.cursor = events.length;
  243 |         return { start: start.t, end: Date.now(), text: String(response?.text ?? "") };
  244 |       }
  245 |       await this.page.waitForTimeout(100);
```