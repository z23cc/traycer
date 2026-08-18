import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { AuthService } from "@/lib/auth/auth-service";
import {
  LOCAL_AUTH_BEARER,
  LOCAL_AUTH_USER_ID,
  setLocalAuthEnabledForTests,
} from "@/lib/auth/local-session";
import { useAuthStore } from "@/stores/auth/auth-store";

const trackedServices: AuthService[] = [];

function makeService(): { service: AuthService; host: MockRunnerHost } {
  const host = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const service = new AuthService({ runnerHost: host });
  trackedServices.push(service);
  return { service, host };
}

describe("local auth session", () => {
  beforeEach(() => {
    setLocalAuthEnabledForTests(true);
    useAuthStore.getState().setSignedOut();
  });

  afterEach(() => {
    setLocalAuthEnabledForTests(null);
    for (const service of trackedServices.splice(0)) {
      service.dispose();
    }
    useAuthStore.getState().setSignedOut();
  });

  it("start() signs in locally without device flow or AuthnV3", async () => {
    const { service, host } = makeService();
    const validate = vi.spyOn(host, "validateAuthTokenIdentity");

    await service.start();

    expect(useAuthStore.getState().status).toBe("signed-in");
    expect(useAuthStore.getState().contextMetadata?.userId).toBe(
      LOCAL_AUTH_USER_ID,
    );
    expect(service.getCurrentSessionSnapshot().token).toBe(LOCAL_AUTH_BEARER);
    expect(host.deviceFlow.startCalls).toBe(0);
    expect(validate).not.toHaveBeenCalled();
  });

  it("signIn() does not open the Traycer device-flow login", async () => {
    const { service, host } = makeService();

    await service.signIn();

    expect(useAuthStore.getState().status).toBe("signed-in");
    expect(service.getCurrentSessionSnapshot().token).toBe(LOCAL_AUTH_BEARER);
    expect(host.deviceFlow.startCalls).toBe(0);
  });

  it("signOut() stays on the local session instead of the sign-in wall", async () => {
    const { service } = makeService();
    await service.start();

    await service.signOut();

    expect(useAuthStore.getState().status).toBe("signed-in");
    expect(service.getCurrentSessionSnapshot().token).toBe(LOCAL_AUTH_BEARER);
  });

  it("does not ask Traycer cloud for registered hosts or sessions", async () => {
    const { service, host } = makeService();
    const listHosts = vi.spyOn(host, "listRegisteredHosts");
    const listSessions = vi.spyOn(host, "listUserSessions");
    await service.start();

    const hosts = await service.fetchRegisteredHosts(service.currentAuthEra());
    const sessions = await service.fetchUserSessions(
      new AbortController().signal,
    );
    const user = await service.fetchAuthenticatedUser();

    expect(hosts).toEqual({ hosts: [] });
    expect(sessions).toEqual({ sessions: [] });
    expect(user?.user.id).toBe(LOCAL_AUTH_USER_ID);
    expect(listHosts).not.toHaveBeenCalled();
    expect(listSessions).not.toHaveBeenCalled();
  });
});
