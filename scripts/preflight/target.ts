/**
 * The deployment under test. HTTP checks accept https, or http only for an explicit loopback `--target` (a local
 * production server). The voice check additionally needs a URL ElevenLabs itself can reach: public https, and the
 * same base URL the agents were synced with, because ElevenLabs calls the agent's configured `custom_llm.url`,
 * not whatever preflight targets.
 */

export type Target =
  | {
      ok: true;
      /** Origin plus path, without a trailing slash. */
      baseUrl: string;
      /** Came from `--target` rather than PUBLIC_BASE_URL. */
      explicit: boolean;
      https: boolean;
      /** localhost, 127/8, ::1, 0.0.0.0, or a private/link-local address. */
      local: boolean;
    }
  | { ok: false; error: string };

/** Origin plus path without trailing slashes; null for anything that is not a plain http(s) URL. */
export function normaliseBaseUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0" || host === "::1" || host === "::") {
    return true;
  }
  if (/^(?:fe80|fc|fd)[0-9a-f]*:/.test(host)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (!v4) return false;
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

export function resolveTarget(input: { cliTarget: string | undefined; publicBaseUrl: string | undefined }): Target {
  const explicit = input.cliTarget !== undefined;
  const raw = input.cliTarget ?? input.publicBaseUrl;
  if (raw === undefined || raw.trim() === "") {
    return { ok: false, error: "no target: pass --target <url> or set PUBLIC_BASE_URL" };
  }
  const baseUrl = normaliseBaseUrl(raw);
  if (baseUrl === null) {
    return {
      ok: false,
      error: `${explicit ? "--target" : "PUBLIC_BASE_URL"} must be an http(s) URL without query, fragment or credentials`,
    };
  }
  const url = new URL(baseUrl);
  return { ok: true, baseUrl, explicit, https: url.protocol === "https:", local: isLocalHostname(url.hostname) };
}

/** Base URL for checks that call the target over HTTP, or an error saying why the target is refused. */
export function httpTarget(target: Target): { ok: true; baseUrl: string } | { ok: false; error: string } {
  if (!target.ok) return target;
  if (target.https) return { ok: true, baseUrl: target.baseUrl };
  if (target.explicit && target.local) return { ok: true, baseUrl: target.baseUrl };
  return {
    ok: false,
    error: `target ${target.baseUrl} is not https (plain http is accepted only for an explicit loopback --target)`,
  };
}

/**
 * Base URL for the voice check, which only means something if ElevenLabs' servers call the same deployment:
 * public https, and equal to PUBLIC_BASE_URL (the agents' `custom_llm.url` is rendered from it).
 */
export function elevenLabsReachableTarget(
  target: Target,
  publicBaseUrl: string | undefined,
): { ok: true; baseUrl: string } | { ok: false; error: string } {
  if (!target.ok) return target;
  if (!target.https || target.local) {
    return {
      ok: false,
      error: `refusing target ${target.baseUrl}: ElevenLabs calls the custom LLM from its own servers, so the target must be a public https URL (not localhost, a private address or plain http)`,
    };
  }
  const configured = publicBaseUrl === undefined ? null : normaliseBaseUrl(publicBaseUrl);
  if (configured === null) {
    return { ok: false, error: "PUBLIC_BASE_URL is missing or invalid; the agents' custom_llm.url is rendered from it" };
  }
  if (configured !== target.baseUrl) {
    return {
      ok: false,
      error: `target ${target.baseUrl} differs from PUBLIC_BASE_URL ${configured}; ElevenLabs calls the agents' configured custom_llm.url, so the result would not describe the target`,
    };
  }
  return { ok: true, baseUrl: target.baseUrl };
}
