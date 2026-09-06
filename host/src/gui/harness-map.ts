import type { ProviderId } from "@traycer/protocol/host/provider-ids";
import { providerIdSchema } from "@traycer/protocol/host/provider-ids";
import { TUI_HARNESS_ID_TO_PROVIDER_ID } from "@traycer/protocol/host/provider-schemas";

export function providerIdForHarness(harnessId: string): ProviderId {
  if (harnessId === "claude") {
    return TUI_HARNESS_ID_TO_PROVIDER_ID.claude;
  }
  const parsed = providerIdSchema.safeParse(harnessId);
  if (parsed.success) {
    return parsed.data;
  }
  return "claude-code";
}
