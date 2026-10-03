import { describe, expect, it } from "vitest";
import { OracleLeakError, OracleMarkerSchema, assertNoOracleMarkers, findMarkersInText } from "../src";

const KYC = "oracle:kyc:0123456789abcdef";
const AML = "oracle:aml_v2:fedcba9876543210fedcba";

function leakError(texts: readonly string[], markers: readonly string[]): OracleLeakError {
  try {
    assertNoOracleMarkers(texts, markers);
  } catch (err) {
    expect(err).toBeInstanceOf(OracleLeakError);
    return err as OracleLeakError;
  }
  throw new Error("expected OracleLeakError");
}

describe("findMarkersInText", () => {
  it("returns the markers present, in the given order", () => {
    expect(findMarkersInText(`a ${AML} b ${KYC}`, [KYC, AML, "oracle:x:0000000000000000"])).toEqual([KYC, AML]);
  });
});

describe("assertNoOracleMarkers", () => {
  it("passes clean texts and an empty marker list", () => {
    expect(() => assertNoOracleMarkers(["case 42: amount=12000", ""], [KYC, AML])).not.toThrow();
    expect(() => assertNoOracleMarkers([KYC], [])).not.toThrow();
  });

  it("names the leaked domains, deduplicated and sorted, without echoing the text or the marker", () => {
    const secretText = "policy dump: threshold 9000 for high-risk countries";
    const err = leakError(["clean", `${secretText} ${KYC}`, `${AML} ${KYC}`], [KYC, AML]);
    expect(err.domainIds).toEqual(["aml_v2", "kyc"]);
    expect(err.message).toContain("aml_v2, kyc");
    expect(err.message).not.toContain(secretText);
    expect(err.message).not.toContain("0123456789abcdef");
  });

  it("still refuses a marker outside the canonical shape, without naming it", () => {
    const err = leakError(["x not-a-marker y"], ["not-a-marker"]);
    expect(err.domainIds).toEqual(["unrecognised"]);
    expect(err.message).not.toContain("not-a-marker");
  });
});

describe("OracleMarkerSchema", () => {
  it.each([KYC, AML])("accepts %s", (marker) => {
    expect(OracleMarkerSchema.safeParse(marker).success).toBe(true);
  });

  it.each(["", "oracle:kyc:0123456789abcde", "oracle:kyc:0123456789ABCDEF", "oracle:1kyc:0123456789abcdef", "kyc:0123456789abcdef"])(
    "rejects %j",
    (marker) => {
      expect(OracleMarkerSchema.safeParse(marker).success).toBe(false);
    },
  );
});
