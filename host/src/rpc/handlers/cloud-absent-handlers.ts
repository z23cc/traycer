import { chatReplicaReadRequestSchema } from "@traycer/protocol/host/epic/chat-replica-read";
import {
  listCloudChatPayloadsRequestSchema,
  readCloudChatPartRequestSchema,
  readCloudChatPayloadRequestSchema,
  setCloudChatVisibilityRequestSchema,
} from "@traycer/protocol/host/epic/cloud-chat";
import {
  mentionGithubCatalogRequestSchema,
  mentionGithubSearchRequestSchema,
} from "@traycer/protocol/host/mention-schemas";
import {
  hostNotificationsCloudFeedClearAllRequestSchema,
  hostNotificationsCloudFeedEntryRequestSchema,
} from "@traycer/protocol/host/notifications/host-notifications";
import {
  prGetLocalDiffRequestSchema,
  prGetLocalDiffSummaryRequestSchema,
  prGetLocalFileDiffRequestSchema,
} from "@traycer/protocol/host/pr-schemas";
import {
  providersInstallPackVersionRequestSchema,
  providersRefreshPackDiscoveryRequestSchema,
  providersRemovePackVersionRequestSchema,
  providersSetPackPolicyRequestSchema,
  providersUsePackVersionRequestSchema,
} from "@traycer/protocol/host/provider-schemas";
import type { RpcHandler, RpcHandlerResult } from "./types";

/**
 * The methods whose subject - a cloud feed, a published chat, a GitHub
 * catalog, a Sherpa pack, a pull request's checkout - does not exist on this
 * host, answered in the vocabulary each contract already has for that.
 *
 * They were all on the analog fallback, which fills a schema by taking its
 * first arm, and for a mutation the first arm is always success. So the host
 * was reporting work it had not done: `{status: "applied", version: 0}` for
 * every cloud-feed mutation, `{ok: true}` for installing and removing a pack,
 * `{ok: true, outcome: "moved"}` for a pack discovery refresh, and - for two
 * READS - `{status: "ok", bytesBase64: "oss"}`, handing back the four
 * characters `oss` as a published chat's bytes for the client to hash and
 * decode.
 *
 * Where a contract has a word for the true state, that word is the answer;
 * where it has none, the call is refused. Deliberately NOT touched: the
 * analogs that were already truthful -`epic.setChatSharingDefault`
 * (`updatedCount: 0`), `epic.resolveCloudChatHead` (`missing`),
 * `epic.chatPublicationState` (`published: false`, and `definitive` left null
 * because none of its three reasons - deleted, superseded, halted - describes
 * a host that never published at all) and `providers.ensurePack`
 * (`managedInstallState: null`) all say something this host can stand behind.
 */

/**
 * `unavailable` is the schema's own word for "the relay could not reach the
 * cloud, and NOTHING was changed anywhere", and its refine requires the
 * version to be null exactly then - which is the shape of a mutation that did
 * not happen. This host has no relay at all, so it is the permanent answer.
 */
const CLOUD_FEED_UNAVAILABLE = { status: "unavailable", version: null };

export const handleCloudFeedMarkRead: RpcHandler = (params) =>
  answer(
    hostNotificationsCloudFeedEntryRequestSchema.safeParse(params),
    CLOUD_FEED_UNAVAILABLE,
  );

export const handleCloudFeedResolve: RpcHandler = (params) =>
  answer(
    hostNotificationsCloudFeedEntryRequestSchema.safeParse(params),
    CLOUD_FEED_UNAVAILABLE,
  );

export const handleCloudFeedClear: RpcHandler = (params) =>
  answer(
    hostNotificationsCloudFeedEntryRequestSchema.safeParse(params),
    CLOUD_FEED_UNAVAILABLE,
  );

export const handleCloudFeedMarkAllRead: RpcHandler = (params) =>
  answer(
    hostNotificationsCloudFeedClearAllRequestSchema.safeParse(params),
    CLOUD_FEED_UNAVAILABLE,
  );

export const handleCloudFeedClearAll: RpcHandler = (params) =>
  answer(
    hostNotificationsCloudFeedClearAllRequestSchema.safeParse(params),
    CLOUD_FEED_UNAVAILABLE,
  );

/**
 * A part this host does not hold is `not-found`, which the contract calls
 * "data, not a throw" precisely so the reader renders a specific state
 * instead of retrying.
 */
export const handleReadCloudChatPart: RpcHandler = (params) =>
  answer(readCloudChatPartRequestSchema.safeParse(params), {
    outcome: { status: "not-found" },
  });

/**
 * `unavailable` is the marker a reader already draws for content it cannot
 * get - which the contract distinguishes from a transport failure exactly so
 * a permanent absence is not retried forever.
 */
export const handleReadCloudChatPayload: RpcHandler = (params) =>
  answer(readCloudChatPayloadRequestSchema.safeParse(params), {
    outcome: { status: "unavailable" },
  });

/**
 * `not-found` - "the cloud holds no row for this identity (never published)" -
 * and NOT `{status: "ok", refs: []}`, which is the mistake this union exists
 * to prevent: its own comment says an outcome union is used "precisely so this
 * case cannot be reported as an empty list, which a reader would render as
 * 'no attachments' for a chat that has them".
 */
export const handleListCloudChatPayloads: RpcHandler = (params) =>
  answer(listCloudChatPayloadsRequestSchema.safeParse(params), {
    outcome: { status: "not-found" },
  });

/**
 * `absent` - "no doc-resident content for this chat on the serving host" -
 * and NOT a stand-in for a read this host could have done.
 *
 * The epic doc does carry a `chats` map here (`seedRoot`), but it holds row
 * METADATA only: id, title, parent, timestamps. This method's `ok` arm is
 * messages and events, which live in the registry and are served by the chat
 * subscribe. That split is already on the wire - `chatRecordSummaryOf` stamps
 * every row `docResident: false`, and the contract calls that marker "which
 * store the row was read out of". This read is the fallback for the OTHER
 * store: a chat that arrived by doc sync from an owner host that is now
 * unreachable. On a single local host no chat is ever that one.
 */
export const handleChatReplicaRead: RpcHandler = (params) =>
  answer(chatReplicaReadRequestSchema.safeParse(params), {
    outcome: { status: "absent" },
  });

/**
 * The response must carry the updated cloud chat row, and there is no such
 * row to carry: the flip did not happen and cannot be described. The analog
 * invented one, owned by a user called `oss`.
 */
export const handleSetCloudChatVisibility: RpcHandler = (params) =>
  refuse(
    setCloudChatVisibilityRequestSchema.safeParse(params),
    "This host publishes no chats to cloud, so there is no visibility to set.",
  );

/**
 * `gh-unavailable` rather than `ok` with no rows: this host runs no GitHub
 * integration, and "consulted GitHub, you have no repositories" is a
 * different statement from "could not consult GitHub".
 */
export const handleMentionGithubCatalog: RpcHandler = (params) =>
  answer(mentionGithubCatalogRequestSchema.safeParse(params), {
    rows: [],
    repositories: [],
    freshnessAt: null,
    stale: false,
    sourceStatus: "gh-unavailable",
    notice: null,
  });

export const handleMentionGithubSearch: RpcHandler = (params) =>
  answer(mentionGithubSearchRequestSchema.safeParse(params), {
    rows: [],
    sourceStatus: "gh-unavailable",
    notice: null,
  });

/**
 * A local PR diff is keyed by `linkGroupKey`, the opaque token the `pr.*`
 * streams mint - and this host refuses those streams, so it never issues one
 * and no key a client could hold resolves to a checkout here. `unavailable` is
 * a normal outcome of this method rather than an error, and
 * `no-local-checkout` is the reason that is true.
 *
 * The analog happened to answer the same thing, because that arm is first in
 * the union. Pinned here so it stays the answer for a reason rather than by
 * coincidence.
 */
const NO_LOCAL_CHECKOUT = { kind: "unavailable", reason: "no-local-checkout" };

export const handlePrGetLocalDiff: RpcHandler = (params) =>
  answer(prGetLocalDiffRequestSchema.safeParse(params), NO_LOCAL_CHECKOUT);

export const handlePrGetLocalDiffSummary: RpcHandler = (params) =>
  answer(
    prGetLocalDiffSummaryRequestSchema.safeParse(params),
    NO_LOCAL_CHECKOUT,
  );

export const handlePrGetLocalFileDiff: RpcHandler = (params) =>
  answer(prGetLocalFileDiffRequestSchema.safeParse(params), NO_LOCAL_CHECKOUT);

/**
 * Packs are Traycer-hosted provider bundles, downloaded and pinned through a
 * service this host does not talk to. Every one of these is a mutation whose
 * success arm the analog was answering with; there is no arm for "this did
 * not happen", so the call is refused.
 */
const NO_PACKS =
  "This host installs no provider packs; each provider CLI is used as it is found.";

export const handleProvidersInstallPackVersion: RpcHandler = (params) =>
  refuse(providersInstallPackVersionRequestSchema.safeParse(params), NO_PACKS);

export const handleProvidersRemovePackVersion: RpcHandler = (params) =>
  refuse(providersRemovePackVersionRequestSchema.safeParse(params), NO_PACKS);

export const handleProvidersUsePackVersion: RpcHandler = (params) =>
  refuse(providersUsePackVersionRequestSchema.safeParse(params), NO_PACKS);

export const handleProvidersSetPackPolicy: RpcHandler = (params) =>
  refuse(providersSetPackPolicyRequestSchema.safeParse(params), NO_PACKS);

export const handleProvidersRefreshPackDiscovery: RpcHandler = (params) =>
  refuse(
    providersRefreshPackDiscoveryRequestSchema.safeParse(params),
    NO_PACKS,
  );

type Parsed = { readonly success: boolean };

function answer(parsed: Parsed, result: unknown): RpcHandlerResult {
  return parsed.success
    ? { ok: true, result }
    : { ok: false, code: "RPC_ERROR", message: malformed(parsed) };
}

function refuse(parsed: Parsed, message: string): RpcHandlerResult {
  return {
    ok: false,
    code: "RPC_ERROR",
    message: parsed.success ? message : malformed(parsed),
  };
}

/**
 * A malformed request is reported as such even here, so a caller that got the
 * shape wrong is not told the feature is missing.
 */
function malformed(parsed: Parsed): string {
  const error = Reflect.get(parsed, "error");
  const message =
    error === null || typeof error !== "object"
      ? null
      : Reflect.get(error, "message");
  return typeof message === "string" ? message : "Malformed request";
}
