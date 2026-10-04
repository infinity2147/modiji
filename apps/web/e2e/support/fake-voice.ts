/**
 * A FAKE ElevenLabs conversation for hermetic browser runs (the e2e servers have no voice credentials and no
 * test reaches ElevenLabs). Test-side only: the page's own code runs unchanged, including the React SDK's
 * `ConversationProvider`, the voice loop, the bridge and the gate. Two things are swapped in:
 *
 * - `/api/voice/token` answers with a placeholder token;
 * - the provider's call to the client SDK's `Conversation.startSession(options)` is rerouted, in the served
 *   JavaScript chunk, to `window.__fakeVoice.start(options)`. The fake reports `onConnect` like the WebRTC SDK
 *   does (before the agent has initialised the conversation) and records every `sendUserMessage`; the test
 *   then plays the agent: its initiation (`onConversationMetadata`), its speech (`onModeChange`, agent
 *   `onMessage`) and the expert's transcribed speech (`onVadScore`, user `onMessage`).
 *
 * The agent says only what the server's custom LLM streams for the control message the gate sent
 * (`speakControlMessage`): the same exact-text path the real agent takes. Control messages carry nonces: they
 * are passed to the LLM route and never printed.
 */
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { E2E_OPERATOR_SECRET } from "./operator";

/** `current=<Conversation>.startSession(<options>)` in the provider (`lockRef.current = Conversation.startSession(...)`). */
const START_SESSION = /current=([\w$]+)\.startSession\(([\w$]+)\)/;

type Callbacks = Record<string, ((arg?: unknown) => void) | undefined>;
type FakeVoiceState = { sent: { at: number; text: string }[]; patched: boolean; started: number };

export type FakeVoice = {
  /** Every text the page sent with `sendUserMessage`, in order (control messages included). */
  sent: () => Promise<{ at: number; text: string }[]>;
  /** The agent has initialised the conversation (`conversation_initiation_metadata`). */
  initialise: () => Promise<void>;
  /** The agent speaks `text` (mode speaking, its transcript), then stops. */
  agentSays: (text: string) => Promise<void>;
  /** The expert speaks and the provider transcribes `text`. */
  expertSays: (text: string) => Promise<void>;
};

/** Installs the fake before the page loads; call before `page.goto`. */
export async function installFakeVoice(page: Page): Promise<FakeVoice> {
  await page.route("**/api/voice/token**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ token: "fake-conversation-token", conversationId: "conv_fake" }) }),
  );
  await page.route("**/_next/static/**/*.js", async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    if (!START_SESSION.test(body)) return route.fulfill({ response, body });
    const patched = body.replace(START_SESSION, (_m, sdk: string, options: string) => `current=(window.__fakeVoice?window.__fakeVoice.start(${options}):${sdk}.startSession(${options}))`);
    return route.fulfill({ response, body: `${patched};window.__fakeVoicePatched=true;` });
  });
  await page.addInitScript(() => {
    const state: FakeVoiceState & { options: Callbacks | null } = { sent: [], patched: false, started: 0, options: null };
    const fake = {
      state,
      async start(options: Callbacks) {
        state.options = options;
        state.started += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        let live = true;
        const zeros = () => new Uint8Array(64);
        const conversation = {
          sendUserMessage(text: string) {
            if (live) state.sent.push({ at: Date.now(), text });
          },
          sendUserActivity() {},
          setMicMuted() {},
          setVolume() {},
          getId: () => "conv_fake",
          getInputByteFrequencyData: zeros,
          getOutputByteFrequencyData: zeros,
          getInputVolume: () => 0,
          getOutputVolume: () => 0,
          sendContextualUpdate() {},
          sendFeedback() {},
          changeInputDevice: async () => {},
          changeOutputDevice: async () => {},
          async endSession() {
            if (!live) return;
            live = false;
            options.onStatusChange?.({ status: "disconnecting" });
            options.onStatusChange?.({ status: "disconnected" });
            options.onDisconnect?.({ reason: "user" });
          },
        };
        // As the WebRTC SDK: created, connected, and onConnect — before the agent has answered the initiation.
        options.onConversationCreated?.(conversation);
        options.onStatusChange?.({ status: "connected" });
        options.onConnect?.({ conversationId: "conv_fake" });
        options.onModeChange?.({ mode: "listening" });
        return conversation;
      },
    };
    (window as unknown as { __fakeVoice: typeof fake }).__fakeVoice = fake;
  });

  const call = (name: string, arg: unknown): Promise<void> =>
    page.evaluate(
      ([n, a]) => {
        const options = (window as unknown as { __fakeVoice: { state: { options: Callbacks | null } } }).__fakeVoice.state.options;
        if (options === null) throw new Error("no fake conversation started");
        options[n as string]?.(a);
      },
      [name, arg] as const,
    );
  const pause = (ms: number) => page.waitForTimeout(ms);
  return {
    sent: () => page.evaluate(() => (window as unknown as { __fakeVoice: { state: FakeVoiceState } }).__fakeVoice.state.sent),
    initialise: () => call("onConversationMetadata", { conversation_id: "conv_fake", agent_output_audio_format: "pcm_48000", user_input_audio_format: "pcm_48000" }),
    async agentSays(text) {
      await call("onModeChange", { mode: "speaking" });
      await call("onMessage", { source: "ai", role: "agent", message: text });
      await pause(1200);
      await call("onModeChange", { mode: "listening" });
    },
    async expertSays(text) {
      for (let i = 0; i < 6; i += 1) {
        await call("onVadScore", { vadScore: 0.95 });
        await pause(150);
      }
      await call("onVadScore", { vadScore: 0.01 });
      await call("onMessage", { source: "user", role: "user", message: text });
    },
  };
}

/** Whether the served chunks were rerouted to the fake (fails loudly if the SDK's bundling changed). */
export async function expectFakeVoicePatched(page: Page): Promise<void> {
  expect(await page.evaluate(() => (window as unknown as { __fakeVoicePatched?: boolean }).__fakeVoicePatched === true), "the SDK's startSession call was not found in the served chunks").toBe(true);
}

/**
 * What the agent says for a control message: the server's custom LLM route (operator bearer), exactly as
 * ElevenLabs calls it. Returns the streamed text, or null when the LLM skipped the turn.
 */
export async function speakControlMessage(request: APIRequestContext, sessionId: string, controlMessage: string): Promise<string | null> {
  const response = await request.post("/api/llm/chat/completions", {
    headers: { authorization: `Bearer ${E2E_OPERATOR_SECRET}` },
    data: {
      model: "vashistha-interviewer-v3",
      stream: true,
      messages: [
        { role: "system", content: "You are the interviewer." },
        { role: "user", content: controlMessage },
      ],
      elevenlabs_extra_body: { sessionId },
    },
  });
  expect(response.status()).toBe(200);
  let text = "";
  let skipped = false;
  for (const event of (await response.text()).split("\n\n")) {
    if (!event.startsWith("data: {")) continue;
    const delta = (JSON.parse(event.slice("data: ".length)) as { choices: [{ delta: { content?: string | null; tool_calls?: unknown } }] }).choices[0].delta;
    if (delta.tool_calls !== undefined) skipped = true;
    if (typeof delta.content === "string") text += delta.content;
  }
  return skipped ? null : text;
}
