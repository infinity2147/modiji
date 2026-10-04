/** Spoken coaching (browser voice): what is said for a reveal and a warning, and when the speaker speaks. */
import { describe, expect, it } from "vitest";
import { ActionIdSchema } from "@vashistha/core";
import type { InterventionView, TutorRule } from "../../lib/contracts/tutor";
import {
  VOICE_ENABLED_KEY,
  VOICE_SPOKEN_KEY,
  createTutorSpeaker,
  interventionKey,
  interventionSpeech,
  interventionSpeechLine,
  pickVoice,
  revealKey,
  revealSpeech,
  speakableQuote,
  type SpeechWindow,
  type StorageLike,
  type VoiceLike,
} from "../../lib/client/tutor/speech";
import type { RevealModel } from "../../lib/client/tutor/view";

const approve = ActionIdSchema.parse("approve");
const QUOTE = "Never approve a new customer from a high-risk country on the spot.";

const rule: TutorRule = {
  ruleId: "rule-never-approve",
  kind: "guardrail",
  when: "country risk is high and customer status is new",
  then: "never approve onboarding",
  stopRule: true,
  quote: {
    text: QUOTE,
    attribution: "The expert, by voice",
    replay: { frameUrl: null, frameNote: "No frame.", screen: [], audioNote: "Audio playback unavailable." },
  },
  level: "untested",
};
const hindi: TutorRule = {
  ...rule,
  ruleId: "rule-hi",
  quote: { ...rule.quote, text: "नए ग्राहक को तुरंत मंज़ूरी मत दो।", language: "hi", translation: "Do not approve a new customer right away." },
};
const untranslated: TutorRule = { ...hindi, ruleId: "rule-hi-2", quote: { ...rule.quote, text: "कभी नहीं।", language: "hi" } };

const intervention: InterventionView = {
  entryId: "e-1",
  caseId: "NS-2026-0201",
  trigger: "guardrail_violation",
  proposedAction: approve,
  ruleIds: [rule.ruleId],
  questionId: "q-1",
  text: `Careful — never approve onboarding. The expert said: "${QUOTE}"`,
  speech: "queued",
};

const reveal = (rules: TutorRule[], correct = false): RevealModel => ({
  correct,
  verdict: correct ? "Right — the expert would also send to enhanced review." : "Not quite — the expert would send to enhanced review.",
  expected: "Send to enhanced review",
  rules,
});

describe("spoken text", () => {
  it("speaks English words as they are, other languages by their English translation, else nothing", () => {
    expect(speakableQuote(rule.quote)).toBe(QUOTE);
    expect(speakableQuote({ ...rule.quote, language: "en" })).toBe(QUOTE);
    expect(speakableQuote(hindi.quote)).toBe("Do not approve a new customer right away.");
    expect(speakableQuote(untranslated.quote)).toBeUndefined();
  });

  it("the reveal is the verdict then the expert's words (at most two, no repeats)", () => {
    expect(revealSpeech(reveal([rule]))).toBe(`Not quite — the expert would send to enhanced review. In the expert's words: “${QUOTE}”`);
    expect(revealSpeech(reveal([rule, hindi], true))).toBe(
      `Right — the expert would also send to enhanced review. In the expert's words: “${QUOTE}” “Do not approve a new customer right away.”`,
    );
    expect(revealSpeech(reveal([rule, { ...rule, ruleId: "dup" }]))).toBe(`Not quite — the expert would send to enhanced review. In the expert's words: “${QUOTE}”`);
    expect(revealSpeech(reveal([rule, hindi, { ...rule, ruleId: "third", quote: { ...rule.quote, text: "Third." } }]))).not.toMatch(/Third/);
    expect(revealSpeech(reveal([untranslated]))).toBe("Not quite — the expert would send to enhanced review. The expert's words are on your screen.");
    expect(revealSpeech(reveal([]))).toBe("Not quite — the expert would send to enhanced review.");
  });

  it("the warning is the text the tutor agent would speak", () => {
    expect(interventionSpeech(intervention)).toBe(intervention.text);
  });

  it("the card's speech line says truthfully who spoke", () => {
    const server = "Queued for the tutor's voice: spoken as soon as the agent is idle";
    const base = { agentConnected: false, supported: true, enabled: true, status: undefined };
    expect(interventionSpeechLine(server, intervention, { ...base, agentConnected: true, status: "spoken" })).toBe(server);
    expect(interventionSpeechLine("Spoken by the tutor", { ...intervention, speech: "spoken" }, base)).toBe("Spoken by the tutor");
    expect(interventionSpeechLine(server, intervention, { ...base, status: "spoken" })).toBe("Spoken by your coach");
    expect(interventionSpeechLine(server, intervention, { ...base, status: "speaking" })).toBe("Your coach is saying");
    expect(interventionSpeechLine(server, intervention, { ...base, enabled: false })).toBe("Voice is off — your coach would say");
    expect(interventionSpeechLine(server, intervention, { ...base, supported: false })).toMatch(/^Not read aloud/);
  });
});

describe("voice choice", () => {
  const v = (lang: string, localService: boolean, isDefault = false): VoiceLike => ({ lang, localService, default: isDefault, name: `${lang}-${localService}` });
  it("prefers an English voice on the device", () => {
    expect(pickVoice([v("hi-IN", true, true), v("en-US", false), v("en-GB", true)])?.name).toBe("en-GB-true");
    expect(pickVoice([v("en-US", true), v("en-IN", true, true)])?.name).toBe("en-IN-true");
    expect(pickVoice([v("fr-FR", true), v("EN-us", false)])?.name).toBe("EN-us-false");
    expect(pickVoice([v("fr-FR", true)])).toBeUndefined();
    expect(pickVoice([])).toBeUndefined();
  });
});

type FakeUtterance = {
  text: string;
  lang: string;
  voice: VoiceLike | null;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
};

/** A fake `speechSynthesis`: utterances queue until the test starts/ends them, like the browser's async events. */
function fakeSpeech(voices: VoiceLike[] = [{ lang: "en-US", localService: true, default: true, name: "Local" }]) {
  const queue: FakeUtterance[] = [];
  const said: string[] = [];
  let cancels = 0;
  const synth = {
    get speaking() {
      return queue.length > 0;
    },
    pending: false,
    getVoices: () => voices,
    speak: (u: FakeUtterance) => queue.push(u),
    cancel: () => {
      cancels += 1;
      for (const u of queue.splice(0)) u.onerror?.();
    },
  };
  class Utterance implements FakeUtterance {
    lang = "";
    voice: VoiceLike | null = null;
    onstart: (() => void) | null = null;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public text: string) {}
  }
  const win = { speechSynthesis: synth, SpeechSynthesisUtterance: Utterance } as unknown as SpeechWindow;
  return {
    win,
    queue,
    said,
    cancels: () => cancels,
    /** The browser starts and finishes the first queued utterance. */
    play() {
      const u = queue[0];
      if (!u) return;
      u.onstart?.();
      said.push(u.text);
      queue.shift();
      u.onend?.();
    },
  };
}

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
}

describe("tutor speaker", () => {
  it("is a no-op where the browser cannot speak", () => {
    const speaker = createTutorSpeaker({ win: undefined });
    expect(speaker.getSnapshot()).toMatchObject({ supported: false, enabled: true });
    expect(speaker.speakOnce("k", "Hello.")).toBe(false);
    expect(speaker.say("k", "Hello.")).toBe(false);
    expect(() => speaker.cancel()).not.toThrow();
  });

  it("says each message once, in an English voice, and remembers it for the tab", () => {
    const fake = fakeSpeech([
      { lang: "hi-IN", localService: true, default: true, name: "Hindi" },
      { lang: "en-GB", localService: true, default: false, name: "English" },
    ]);
    const session = memoryStorage();
    const speaker = createTutorSpeaker({ win: fake.win, session: () => session });
    const changes: string[] = [];
    speaker.subscribe(() => changes.push(speaker.getSnapshot().speaking ?? "-"));

    expect(speaker.speakOnce(revealKey("p-1"), "Right.")).toBe(true);
    expect(speaker.status(revealKey("p-1"))).toBe("speaking");
    expect(speaker.speakOnce(revealKey("p-1"), "Right.")).toBe(false); // a re-render while queued
    expect(fake.queue).toHaveLength(1);
    expect(fake.queue[0]).toMatchObject({ lang: "en-GB", voice: { name: "English" } });
    fake.play();
    expect(fake.said).toEqual(["Right."]);
    expect(speaker.status(revealKey("p-1"))).toBe("spoken");
    expect(speaker.speakOnce(revealKey("p-1"), "Right.")).toBe(false); // a refresh of the tutor view
    expect(JSON.parse(session.data[VOICE_SPOKEN_KEY] ?? "[]")).toEqual(["reveal:p-1"]);
    expect(changes.at(-1)).toBe("-");

    // A reload in the same tab: still said.
    const again = createTutorSpeaker({ win: fake.win, session: () => session });
    expect(again.status(revealKey("p-1"))).toBe("spoken");
    expect(again.speakOnce(revealKey("p-1"), "Right.")).toBe(false);
    // An explicit replay speaks anyway.
    expect(again.say(revealKey("p-1"), "Right.")).toBe(true);
    expect(fake.queue).toHaveLength(1);
  });

  it("a new message cuts off the current one; a message cancelled before it started is said next time", () => {
    const fake = fakeSpeech();
    const speaker = createTutorSpeaker({ win: fake.win });
    speaker.speakOnce(revealKey("p-1"), "The reveal.");
    speaker.speakOnce(interventionKey("q-1"), "The warning.");
    expect(fake.cancels()).toBe(1);
    expect(fake.queue.map((u) => u.text)).toEqual(["The warning."]);
    expect(speaker.getSnapshot().speaking).toBe("intervention:q-1"); // the old utterance's error event is ignored
    speaker.cancel(); // the case changed
    expect(fake.queue).toEqual([]);
    expect(speaker.getSnapshot().speaking).toBeNull();
    expect(speaker.status(interventionKey("q-1"))).toBeUndefined();
    expect(speaker.speakOnce(interventionKey("q-1"), "The warning.")).toBe(true); // React's dev double effect re-speaks
  });

  it("on by default; off is remembered, silences and cuts off speech; storage errors are harmless", () => {
    const fake = fakeSpeech();
    const local = memoryStorage();
    const speaker = createTutorSpeaker({ win: fake.win, local: () => local });
    expect(speaker.getSnapshot().enabled).toBe(true);
    speaker.speakOnce("a", "One.");
    speaker.toggle();
    expect(local.data[VOICE_ENABLED_KEY]).toBe("off");
    expect(fake.queue).toEqual([]);
    expect(speaker.speakOnce("b", "Two.")).toBe(false);
    expect(createTutorSpeaker({ win: fake.win, local: () => local }).getSnapshot().enabled).toBe(false);
    speaker.toggle();
    expect(local.data[VOICE_ENABLED_KEY]).toBe("on");
    expect(speaker.speakOnce("b", "Two.")).toBe(true);

    const throwing = () => {
      throw new Error("SecurityError");
    };
    const blocked = createTutorSpeaker({ win: fake.win, local: throwing, session: throwing });
    expect(blocked.getSnapshot().enabled).toBe(true);
    blocked.toggle();
    expect(blocked.getSnapshot().enabled).toBe(false);
    const garbage = createTutorSpeaker({ win: fake.win, session: () => memoryStorage({ [VOICE_SPOKEN_KEY]: "{not json" }) });
    expect(garbage.getSnapshot().spoken.size).toBe(0);
  });

  it("a hold (the tutor agent is connected) silences it until every hold is released", () => {
    const fake = fakeSpeech();
    const speaker = createTutorSpeaker({ win: fake.win });
    speaker.speakOnce("a", "One.");
    const release = speaker.hold();
    expect(fake.queue).toEqual([]);
    expect(speaker.getSnapshot().held).toBe(true);
    expect(speaker.speakOnce("a", "One.")).toBe(false);
    expect(speaker.say("a", "One.")).toBe(false);
    const second = speaker.hold();
    release();
    release(); // releasing twice counts once
    expect(speaker.getSnapshot().held).toBe(true);
    second();
    expect(speaker.getSnapshot().held).toBe(false);
    expect(speaker.speakOnce("a", "One.")).toBe(true);
  });
});
