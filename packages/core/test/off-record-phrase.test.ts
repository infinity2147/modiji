import { describe, expect, it } from "vitest";
import {
  DEFAULT_OFF_RECORD_PHRASES,
  createOffRecordPhraseMatcher,
  formatControlMessage,
  isOffRecordPhrase,
  normaliseUtterance,
} from "../src/index";

describe("normaliseUtterance", () => {
  it("lower-cases, strips punctuation, hyphens and dandas, and collapses whitespace", () => {
    expect(normaliseUtterance("  Off-the-RECORD, please!! ")).toBe("off the record please");
    expect(normaliseUtterance("रिकॉर्डिंग बंद करो।")).toBe("रिकॉर्डिंग बंद करो");
  });

  it("keeps Devanagari combining marks and unifies precomposed nukta letters (NFKC)", () => {
    expect(normaliseUtterance("ऑफ़ द रिकॉर्ड")).toBe(normaliseUtterance("ऑफ़ द रिकॉर्ड"));
  });
});

describe("isOffRecordPhrase (default phrases)", () => {
  it.each([
    "Off the record.",
    "off the record",
    "Let's go off the record for a moment.",
    "Okay, can we go off record please?",
    "Pause recording.",
    "Please stop the recording now",
    "OFF-THE-RECORD",
    "recording band karo",
    "रिकॉर्डिंग बंद करो।",
    "ऑफ़ द रिकॉर्ड",
  ])("matches %j", (utterance) => {
    expect(isOffRecordPhrase(utterance)).toBe(true);
  });

  it.each([
    "",
    "   ",
    "We escalate when the ownership is over twenty-five percent.",
    "the record shows the owner is verified",
    "recording",
    "off",
    "I said earlier that the jurisdiction risk alone is never enough to escalate, off the record",
    "offtherecord",
    formatControlMessage("A".repeat(43)),
    `off the record ${"x".repeat(200)}`,
  ])("does not match %j", (utterance) => {
    expect(isOffRecordPhrase(utterance)).toBe(false);
  });

  it("matches every default phrase on its own", () => {
    for (const phrase of DEFAULT_OFF_RECORD_PHRASES) expect(isOffRecordPhrase(phrase)).toBe(true);
  });
});

describe("createOffRecordPhraseMatcher", () => {
  it("uses a configured list instead of the defaults", () => {
    const match = createOffRecordPhraseMatcher(["privacy please"]);
    expect(match("Privacy, please.")).toBe(true);
    expect(match("off the record")).toBe(false);
  });

  it("rejects a phrase with no words", () => {
    expect(() => createOffRecordPhraseMatcher(["ok", " ?! "])).toThrow(/no words/);
  });
});
