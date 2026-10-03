import { describe, expect, it } from "vitest";
import { elevenLabsReachableTarget, httpTarget, isLocalHostname, normaliseBaseUrl, resolveTarget } from "../preflight/target";

describe("target policy", () => {
  it("normalises base URLs and rejects queries, fragments and credentials", () => {
    expect(normaliseBaseUrl("https://x.example/app/")).toBe("https://x.example/app");
    expect(normaliseBaseUrl("https://X.example")).toBe("https://x.example");
    expect(normaliseBaseUrl("https://x.example/?a=1")).toBeNull();
    expect(normaliseBaseUrl("https://u:p@x.example")).toBeNull();
    expect(normaliseBaseUrl("ftp://x.example")).toBeNull();
    expect(normaliseBaseUrl("not a url")).toBeNull();
  });

  it("classifies local hosts", () => {
    for (const h of ["localhost", "app.localhost", "127.0.0.1", "127.9.9.9", "[::1]", "0.0.0.0", "10.1.2.3", "192.168.1.5", "172.20.0.1", "169.254.1.1"]) {
      expect(isLocalHostname(h), h).toBe(true);
    }
    for (const h of ["example.org", "8.8.8.8", "172.32.0.1", "vashistha.up.railway.app"]) expect(isLocalHostname(h), h).toBe(false);
  });

  it("defaults to PUBLIC_BASE_URL and prefers --target", () => {
    expect(resolveTarget({ cliTarget: undefined, publicBaseUrl: "https://a.example/" })).toMatchObject({ ok: true, baseUrl: "https://a.example", explicit: false });
    expect(resolveTarget({ cliTarget: "http://127.0.0.1:4000", publicBaseUrl: "https://a.example" })).toMatchObject({
      ok: true,
      baseUrl: "http://127.0.0.1:4000",
      explicit: true,
      https: false,
      local: true,
    });
    expect(resolveTarget({ cliTarget: undefined, publicBaseUrl: undefined })).toMatchObject({ ok: false });
  });

  it("allows plain http only for an explicit loopback --target", () => {
    expect(httpTarget(resolveTarget({ cliTarget: "http://127.0.0.1:4000", publicBaseUrl: undefined })).ok).toBe(true);
    expect(httpTarget(resolveTarget({ cliTarget: undefined, publicBaseUrl: "http://127.0.0.1:4000" })).ok).toBe(false);
    expect(httpTarget(resolveTarget({ cliTarget: "http://example.org", publicBaseUrl: undefined })).ok).toBe(false);
  });

  it("the voice check refuses http, localhost, private addresses and targets other than PUBLIC_BASE_URL", () => {
    const pub = "https://a.example";
    const refuse = (cliTarget: string) => elevenLabsReachableTarget(resolveTarget({ cliTarget, publicBaseUrl: pub }), pub);
    expect(refuse("http://127.0.0.1:4000")).toMatchObject({ ok: false, error: expect.stringMatching(/ElevenLabs calls the custom LLM from its own servers/) });
    expect(refuse("https://localhost:4000").ok).toBe(false);
    expect(refuse("https://192.168.1.10").ok).toBe(false);
    expect(refuse("http://a.example").ok).toBe(false);
    expect(refuse("https://b.example")).toMatchObject({ ok: false, error: expect.stringMatching(/differs from PUBLIC_BASE_URL/) });
    expect(refuse("https://a.example/")).toEqual({ ok: true, baseUrl: pub });
  });
});
