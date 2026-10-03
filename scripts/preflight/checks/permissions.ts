import type { CheckOutcome } from "../types";

/** Printed, not checked: browser permissions can only be granted by a person at the demo machine. */
export const PERMISSIONS_CHECKLIST: readonly string[] = [
  "Use Chrome (latest stable) on the demo machine; open the app on its HTTPS origin (PUBLIC_BASE_URL), never http or a LAN IP.",
  "Site settings for that origin: Microphone = Allow; pick the demo headset as the input device.",
  'Screen share via getDisplayMedia: choose "Entire screen" or the CaseDesk "Window"; leave "Also share tab audio" OFF.',
  "macOS: System Settings → Privacy & Security → Screen Recording and Microphone both enabled for Chrome (restart Chrome after granting).",
  "Close notification sources (Do Not Disturb on, Slack/Mail quit) and every other tab or window with personal data or PII.",
  "Test the headset: confirm the input level moves when you speak (OS sound settings) and that agent speech plays in the headset only, not the room.",
];

export async function checkPermissions(): Promise<CheckOutcome> {
  return {
    status: "info",
    detail: `${PERMISSIONS_CHECKLIST.length}-item mic/screen checklist for the demo machine (printed below)`,
    facts: { checklist: [...PERMISSIONS_CHECKLIST] },
  };
}
