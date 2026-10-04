/**
 * The scripted expert, driving the PRODUCTION CaseDesk through the real UI: start an Expert session,
 * share the (synthetic) screen, start the interview, open cases, rate risk and decide with the mouse or
 * keyboard, scroll, type, and speak pre-generated synthetic voice lines (ElevenLabs TTS) into the
 * harness microphone when the interviewer agent has finished asking.
 */
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { installHarness, type HarnessEvent, type LiveApi } from "./harness";
import { clip } from "./tts";

export type Entry = {
  id: string;
  sequence: number;
  source: string;
  kind: string;
  occurredAt: number;
  receivedAt: number;
  privacyEpoch: number;
  parentIds: string[];
  payload: Record<string, unknown>;
};

export const RATING_LABEL = { low: "Low", medium: "Medium", high: "High" } as const;
export const OUTCOME_LABEL = {
  approve: "Approve onboarding",
  enhancedReview: "Send to enhanced review",
  requestDocuments: "Request documents",
  escalateCompliance: "Escalate to compliance officer",
  reject: "Reject",
} as const;
export type Rating = keyof typeof RATING_LABEL;
export type Outcome = keyof typeof OUTCOME_LABEL;

type W = { __live: LiveApi };

export class Expert {
  readonly page: Page;
  readonly request: APIRequestContext;
  sessionId = "";
  conversationId = "";
  private loaded = new Map<string, string>();
  private cursor = 0;
  /** Every spoken line: local start/end (Date.now in the page) and what was said. */
  readonly spoken: { label: string; text: string; start: number; end: number; gain: number }[] = [];

  constructor(page: Page, request: APIRequestContext) {
    this.page = page;
    this.request = request;
  }

  static async open(page: Page, request: APIRequestContext): Promise<Expert> {
    await page.addInitScript(installHarness, { agentRmsThreshold: 0.008, agentSilenceMs: 1000 });
    return new Expert(page, request);
  }

  async events(): Promise<HarnessEvent[]> {
    return this.page.evaluate(() => (window as unknown as W).__live.events);
  }

  async mark(label: string, data: Record<string, unknown> = {}): Promise<void> {
    await this.page.evaluate(([l, d]) => (window as unknown as W).__live.mark(l, d), [label, data] as const);
  }

  async startSession(set: "Training" | "Practice" | "Held-out" = "Training"): Promise<string> {
    await this.page.goto("/sandbox");
    await this.page.getByRole("radio", { name: /^Expert capture/ }).click();
    await this.page.getByRole("radio", { name: new RegExp(`^${set}`) }).click();
    await this.page.getByRole("button", { name: "Start session" }).click();
    await expect(this.page).toHaveURL(/session=/, { timeout: 30_000 });
    this.sessionId = new URL(this.page.url()).searchParams.get("session") ?? "";
    await expect(this.queue().first()).toBeVisible({ timeout: 30_000 });
    return this.sessionId;
  }

  queue() {
    return this.page.getByRole("list", { name: "Cases" }).getByRole("button");
  }

  async shareScreen(): Promise<void> {
    const card = this.page.getByRole("region", { name: "Screen capture" });
    await card.getByRole("button", { name: "Share screen" }).click();
    await expect(card.getByRole("status", { name: "Screen capture status" })).toHaveText("Capturing", { timeout: 30_000 });
  }

  async startInterview(): Promise<string> {
    await this.page.getByRole("button", { name: "Start interview" }).click();
    await expect(this.page.getByRole("status", { name: "Voice status" })).toHaveText("Connected", { timeout: 45_000 });
    await expect.poll(async () => (await this.events()).some((e) => e.type === "remote_audio_track"), { timeout: 30_000 }).toBe(true);
    const response = (await this.events()).find((e) => e.type === "fetch_voice_token");
    void response;
    return this.conversationId;
  }

  /** Reconnects if the conversation ended (e.g. the provider closed it); returns true if it had to. */
  async ensureConnected(): Promise<boolean> {
    const status = (await this.page.getByRole("status", { name: "Voice status" }).textContent()) ?? "";
    if (status.includes("Connected")) return false;
    await this.mark("reconnect", { status });
    await this.page.getByRole("button", { name: "Start interview" }).click();
    await expect(this.page.getByRole("status", { name: "Voice status" })).toHaveText("Connected", { timeout: 45_000 });
    await this.page.waitForTimeout(1500);
    return true;
  }

  async endInterview(): Promise<void> {
    const end = this.page.getByRole("button", { name: "End conversation" });
    if (await end.isVisible()) await end.click();
  }

  async screen(lines: string[], offset = 0): Promise<void> {
    await this.page.evaluate(([l, o]) => (window as unknown as W).__live.screen(l, o), [lines, offset] as const);
  }

  async openCase(index: number): Promise<string> {
    const item = this.queue().nth(index);
    const text = (await item.textContent()) ?? "";
    const caseId = /NS-\d{4}-\d{4}/.exec(text)?.[0] ?? `#${index}`;
    await item.click();
    await expect(this.page.getByRole("article")).toContainText(caseId);
    await this.screen([`Case ${caseId}`, "Customer · Relationship · Beneficial owners", "Screening · Source of funds · Documents", "Risk rating: unrated"]);
    await this.mark("open_case", { caseId });
    return caseId;
  }

  async rate(rating: Rating): Promise<void> {
    await this.page.getByRole("combobox", { name: "Risk rating" }).click();
    await this.page.getByRole("option", { name: RATING_LABEL[rating], exact: true }).click();
  }

  /** Rates with the keyboard only (focus the select, open it, arrow to the rating, Enter). */
  async rateByKeyboard(rating: Rating): Promise<void> {
    const trigger = this.page.getByRole("combobox", { name: "Risk rating" });
    await trigger.focus();
    await this.page.keyboard.press("Enter");
    await expect(this.page.getByRole("option", { name: RATING_LABEL[rating], exact: true })).toBeVisible();
    await this.page.getByRole("option", { name: RATING_LABEL[rating], exact: true }).focus();
    await this.page.keyboard.press("Enter");
  }

  async decide(outcome: Outcome): Promise<void> {
    await this.page.getByRole("radio", { name: OUTCOME_LABEL[outcome] }).click();
    await this.page.getByRole("button", { name: "Save decision" }).click();
    const committed = this.page.getByRole("status").filter({ hasText: "Decision committed" });
    const dialog = this.page.getByRole("dialog");
    await expect(committed.or(dialog).first()).toBeVisible({ timeout: 20_000 });
    if (await dialog.isVisible()) throw new Error(`interlock dialog on Save: ${(await dialog.textContent())?.slice(0, 500)}`);
    await this.mark("committed", { outcome });
  }

  /**
   * Real keystrokes in the case file area (the expert "typing a note"). CaseDesk has no free-text field
   * in Expert mode, so the TEST makes the case-file <main> focusable (tabindex=-1, test-side DOM
   * attribute only) and types there; the keystrokes reach the work area like typing in any field would.
   */
  async typeNote(text: string, delayMs = 70): Promise<{ start: number; end: number }> {
    const main = this.page.locator("main:has(article)");
    await main.evaluate((el) => el.setAttribute("tabindex", "-1"));
    await main.focus();
    const start = Date.now();
    await this.page.keyboard.type(text, { delay: delayMs });
    return { start, end: Date.now() };
  }

  async scrollCase(steps: number, deltaY: number, pauseMs: number): Promise<void> {
    await this.page.locator("main:has(article)").hover();
    for (let i = 0; i < steps; i += 1) {
      await this.page.mouse.wheel(0, i % 2 === 0 ? deltaY : -deltaY);
      await this.screen([`scrolling… ${i}`], (i % 5) * 40);
      await this.page.waitForTimeout(pauseMs);
    }
  }

  private async ensureLoaded(text: string): Promise<string> {
    const cached = this.loaded.get(text);
    if (cached !== undefined) return cached;
    const c = await clip(text);
    await this.page.evaluate(([k, b]) => (window as unknown as W).__live.load(k, b), [c.key, c.base64] as const);
    this.loaded.set(text, c.key);
    return c.key;
  }

  async preload(texts: readonly string[]): Promise<void> {
    for (const text of texts) await this.ensureLoaded(text);
  }

  /** Speaks `text` (synthetic voice input, ElevenLabs TTS) into the microphone and waits until it has played. */
  async say(text: string, label = "line", gain = 1): Promise<{ start: number; end: number }> {
    const key = await this.ensureLoaded(text);
    const window_ = await this.page.evaluate(([k, g, l]) => (window as unknown as W).__live.play(k, g, l), [key, gain, label] as const);
    this.spoken.push({ label, text, gain, ...window_ });
    return window_;
  }

  /** Starts speaking without waiting (to type or scroll while talking). */
  sayAsync(text: string, label = "line", gain = 1): Promise<{ start: number; end: number }> {
    return this.say(text, label, gain);
  }

  async noise(level: number): Promise<void> {
    await this.page.evaluate((l) => (window as unknown as W).__live.noise(l), level);
  }

  /**
   * Waits for the agent's next spoken turn after the current cursor: its audio onset, its end (1 s of
   * silence on the track, the SDK mode back to listening) and the agent_response text. Returns null on timeout (no question was asked).
   */
  async waitForAgentTurn(timeoutMs: number): Promise<{ start: number; end: number; text: string } | null> {
    const deadline = Date.now() + timeoutMs;
    /** Index of the turn's first audio onset in the page's event log (indices are stable: the log only grows). */
    let startIndex = -1;
    for (;;) {
      const events = await this.events();
      if (startIndex < 0) startIndex = events.findIndex((e, i) => i >= this.cursor && e.type === "agent_audio_start");
      const start = startIndex < 0 ? undefined : events[startIndex];
      if (start !== undefined) {
        const after = events.slice(startIndex);
        const audio = after.filter((e) => e.type === "agent_audio_start" || e.type === "agent_audio_end");
        const last = audio.at(-1);
        const response = events.slice(this.cursor).find((e) => e.type === "agent_response");
        const silent = after.filter((e) => e.type === "ui_agent_mode").at(-1)?.mode !== "speaking";
        if (last?.type === "agent_audio_end" && response !== undefined && silent) {
          this.cursor = events.lastIndexOf(last) + 1;
          return { start: start.t, end: last.t, text: typeof response.text === "string" ? response.text : "" };
        }
      }
      if (Date.now() > deadline) {
        if (start === undefined) return null;
        // Audio began but never settled: report what we have.
        const response = events.slice(this.cursor).find((e) => e.type === "agent_response");
        this.cursor = events.length;
        return { start: start.t, end: Date.now(), text: String(response?.text ?? "") };
      }
      await this.page.waitForTimeout(100);
    }
  }

  /** Moves the turn cursor to now (ignore agent turns before this point). */
  async resetCursor(): Promise<void> {
    this.cursor = (await this.events()).length;
  }

  async ledger(): Promise<Entry[]> {
    const out: Entry[] = [];
    let after: number | undefined;
    for (;;) {
      const response = await this.request.get(`/api/sessions/${this.sessionId}/ledger?limit=500${after === undefined ? "" : `&after=${after}`}`);
      expect(response.ok()).toBe(true);
      const page = ((await response.json()) as { entries: Entry[] }).entries;
      out.push(...page);
      if (page.length < 500) return out;
      after = page.at(-1)?.sequence;
    }
  }
}
