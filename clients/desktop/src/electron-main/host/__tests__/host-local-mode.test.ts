import { describe, expect, it } from "vitest";
import {
  isLocalInRepoHost,
  TRAYCER_LOCAL_HOST_ENV,
} from "../host-local-mode";

describe("isLocalInRepoHost", () => {
  it("is true only when TRAYCER_LOCAL_HOST=1", () => {
    expect(isLocalInRepoHost({})).toBe(false);
    expect(isLocalInRepoHost({ [TRAYCER_LOCAL_HOST_ENV]: "0" })).toBe(false);
    expect(isLocalInRepoHost({ [TRAYCER_LOCAL_HOST_ENV]: "1" })).toBe(true);
  });
});
