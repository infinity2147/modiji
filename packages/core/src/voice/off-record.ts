/**
 * Off the record by voice (plan §7.8). Deterministic: a fixed phrase list, matched on normalised words —
 * no model decides. Shared by the custom-LLM wrapper (which answers a matching expert turn with the
 * `set_off_record` client tool call and no speech) and the browser bridge (which never records or shows
 * the matching transcript and goes off the record itself, without waiting for the tool call).
 *
 * The matcher errs towards privacy: a short utterance containing a phrase as whole words matches even
 * when it was not meant as a command ("don't stop recording"). The cost is one unrecorded sentence and
 * a button press to resume; the opposite error would record what the expert asked us not to.
 */

/** Client tool the agents define (agents/*.json `clientTools`) and the browser handles. */
export const SET_OFF_RECORD_TOOL = "set_off_record";

/** English, plus Hindi in Devanagari and romanised (Scribe may transcribe Hindi in either script). */
export const DEFAULT_OFF_RECORD_PHRASES: readonly string[] = [
  "off the record",
  "off record",
  "go off record",
  "go off the record",
  "pause recording",
  "pause the recording",
  "stop recording",
  "stop the recording",
  "record band karo",
  "recording band karo",
  "recording roko",
  "record mat karo",
  "रिकॉर्ड बंद करो",
  "रिकॉर्डिंग बंद करो",
  "रिकॉर्डिंग रोको",
  "रिकॉर्ड मत करो",
  "ऑफ द रिकॉर्ड",
  "ऑफ़ द रिकॉर्ड",
];

/**
 * How many words besides the phrase an utterance may have and still count as the command
 * ("okay, can we go off the record please" matches; a long answer that mentions it does not).
 */
export const OFF_RECORD_MAX_EXTRA_WORDS = 5;

/** Longer input is never a command; checked before normalising. */
const MAX_COMMAND_CHARS = 200;

/**
 * NFKC, lower case, apostrophes dropped ("let's" → "lets"), every other run of non-letters/marks/digits
 * (punctuation, `_`, `-`, danda) → one space.
 */
export function normaliseUtterance(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim();
}

export type OffRecordPhraseMatcher = (utterance: string) => boolean;

/** A matcher over `phrases` (configurable; defaults to `DEFAULT_OFF_RECORD_PHRASES`). Throws on an empty phrase. */
export function createOffRecordPhraseMatcher(phrases: readonly string[] = DEFAULT_OFF_RECORD_PHRASES): OffRecordPhraseMatcher {
  const sequences = phrases.map((phrase) => {
    const words = normaliseUtterance(phrase).split(" ");
    if (words[0] === "") throw new Error(`off-record phrase ${JSON.stringify(phrase)} has no words`);
    return words;
  });
  return (utterance) => {
    if (utterance.length > MAX_COMMAND_CHARS) return false;
    const normalised = normaliseUtterance(utterance);
    if (normalised === "") return false;
    const words = normalised.split(" ");
    return sequences.some(
      (seq) =>
        words.length - seq.length <= OFF_RECORD_MAX_EXTRA_WORDS &&
        words.some((_, start) => seq.every((word, i) => words[start + i] === word)),
    );
  };
}

export const isOffRecordPhrase: OffRecordPhraseMatcher = createOffRecordPhraseMatcher();
