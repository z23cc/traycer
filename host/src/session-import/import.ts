import { existsSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type { GuiHarnessId } from "@traycer/protocol/host/agent/shared";
import type { SessionImportSelection } from "@traycer/protocol/host/session-import/candidate";
import type { SessionImportOutcome } from "@traycer/protocol/host/session-import/run";
import { seedGuiChat } from "../agent/gui-chat";
import { bindEpicWorkspaces } from "../rpc/handlers/epic-handlers";
import type { HostRuntime } from "../runtime";
import type { StoredChat, StoredTurn } from "../store/host-store";
import type { DiscoveredSession } from "./discover";
import { isHarnessPreamble, messageText } from "./vendor";

/**
 * Turns one discovered native session into a real epic and chat.
 *
 * This is the moment the scan deliberately avoids: the transcript is opened
 * and parsed. It is opened ONCE, for a session the user picked, which is why
 * reading the whole file is affordable here and would not have been there.
 *
 * The import is idempotent per `(harness, nativeSessionId)`, and the mechanism
 * is the chat's own `providerSession`: a chat that already carries the pair IS
 * the previous import, and it answers with its own ids rather than making a
 * second copy. The chat id is derived from the pair as well, so the two agree
 * even before the lookup finds anything.
 */

/**
 * How much transcript text one imported chat keeps, and from which end.
 *
 * The same bound and the same end the host already uses when it hands history
 * to a harness: the tail is what a continuation needs. It is not a nicety
 * here - the sessions on this machine run to 25 MB each and 400 MB in total,
 * and the store is one JSON file rewritten on every mutation, so importing
 * transcripts whole would put the host's own durability in the hands of how
 * much the user has typed into Claude this year.
 */
const MAX_TRANSCRIPT_CHARS = 80_000;

/** What a truncated import says for itself, in the vocabulary chats already have. */
const TRUNCATED_MESSAGE =
  "Earlier history stayed in the source session file; the most recent exchanges were imported.";

export async function importSession(
  runtime: HostRuntime,
  selection: SessionImportSelection,
  permissionMode: string,
  found: DiscoveredSession | null,
): Promise<SessionImportOutcome> {
  const existing = findImported(runtime, selection);
  if (existing !== null) {
    return { kind: "skipped_already_imported", ...existing };
  }
  if (found === null) {
    return {
      kind: "failed",
      reason: "source_unreadable",
      detail: `No ${selection.harness} session named ${selection.nativeSessionId} is on this host.`,
    };
  }
  let turns: readonly ParsedTurn[];
  try {
    turns = readTranscript(found.file, selection.harness);
  } catch (error) {
    return {
      kind: "failed",
      reason: "source_unreadable",
      detail: String(error),
    };
  }
  if (turns.length === 0) {
    return {
      kind: "failed",
      reason: "source_empty",
      detail: "The session holds no message worth a chat.",
    };
  }
  const kept = tail(turns);
  const chatId = chatIdFor(selection);
  const epicId = randomUUID();
  const now = Date.now();
  const candidate = found.candidate;
  const title = titleOf(candidate.title, kept);
  // A folder that is gone imports FOLDERLESS rather than failing - that is
  // what makes `missing_folder` a location in the scan instead of an error,
  // and the same existence test the scan grouped by decides it here.
  const folder = found.folder;
  const workspaces = folder === null || !existsSync(folder) ? [] : [folder];
  try {
    await runtime.store.mutate((state) => {
      state.epics = state.epics.filter((row) => row.id !== epicId);
      state.epics.unshift({
        id: epicId,
        title,
        initialUserPrompt: candidate.firstPrompt ?? "",
        status: "active",
        createdAt: candidate.createdAt,
        updatedAt: now,
        createdBy: "session-import",
        version: "2.0.0",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        repos: [],
        workspaces,
        pinned: false,
        lastViewedAt: null,
      });
      seedGuiChat(
        state,
        chatOf(runtime, {
          epicId,
          chatId,
          title,
          createdAt: candidate.createdAt,
          harness: selection.harness,
          nativeSessionId: selection.nativeSessionId,
          permissionMode,
          turns: kept.map((turn) =>
            storedTurn(turn, chatId, selection.harness),
          ),
          truncated: kept.length < turns.length,
        }),
        selection.harness,
      );
    });
  } catch (error) {
    return { kind: "failed", reason: "creation_failed", detail: String(error) };
  }
  try {
    await bindEpicWorkspaces(runtime, epicId, workspaces, chatId);
  } catch (error) {
    return {
      kind: "failed",
      reason: "workspace_bind_failed",
      detail: String(error),
    };
  }
  return { kind: "imported", epicId, chatId };
}

/**
 * Every native session that already has a chat here, as
 * `harness:nativeSessionId`. The scan hides these rather than offering them:
 * the contract keeps an `already_in_traycer` state only so a client can parse
 * what an OLDER host emits, and says a current host shows the user what is
 * new.
 *
 * Wider than "already imported", and deliberately so: a chat that RAN a
 * harness here carries the same `providerSession`, and its transcript is
 * sitting in the vendor's directory like any other. Offering that one back
 * would import a conversation the user is already looking at.
 */
export function sessionsAlreadyInTraycer(runtime: HostRuntime): Set<string> {
  const keys = new Set<string>();
  for (const chat of runtime.store.snapshot().chats) {
    const session = chat.providerSession;
    if (session !== null) {
      keys.add(`${session.harnessId}:${session.sessionId}`);
    }
  }
  return keys;
}

/**
 * The previous import of this pair, by the `providerSession` it was stamped
 * with. The derived chat id would find the chat too, but only the stored row
 * carries the epic it ended up in, which the outcome has to name.
 */
export function findImported(
  runtime: HostRuntime,
  selection: SessionImportSelection,
): { readonly epicId: string; readonly chatId: string } | null {
  const chat = runtime.store
    .snapshot()
    .chats.find(
      (row) =>
        row.providerSession !== null &&
        row.providerSession.harnessId === selection.harness &&
        row.providerSession.sessionId === selection.nativeSessionId,
    );
  return chat === undefined
    ? null
    : { epicId: chat.epicId, chatId: chat.chatId };
}

/**
 * A stable chat id for one native session, in the UUID shape every other id
 * here has. Derived rather than random so two hosts - or one host whose store
 * was rolled back - name the same import the same way.
 */
export function chatIdFor(selection: SessionImportSelection): string {
  const digest = createHash("sha1")
    .update(
      `traycer:session-import:${selection.harness}:${selection.nativeSessionId}`,
    )
    .digest("hex");
  const variant = ((parseInt(digest.slice(16, 18), 16) & 0x3f) | 0x80).toString(
    16,
  );
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `5${digest.slice(13, 16)}`,
    `${variant}${digest.slice(18, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

type ParsedTurn = {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly timestamp: number;
};

/**
 * Every message in one transcript, in order.
 *
 * ponytail: the file is read whole. A 25 MB session costs one 25 MB read at
 * import and nothing afterwards, which is the trade the tail bound below is
 * built on; stream it line by line if a provider ever writes something an
 * order of magnitude larger.
 */
export function readTranscript(
  file: string,
  harness: GuiHarnessId,
): ParsedTurn[] {
  const turns: ParsedTurn[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.length === 0) {
      continue;
    }
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      // One unreadable line is not an unreadable session: the vendor appends
      // to this file, so a torn last write is ordinary.
      continue;
    }
    if (row === null || typeof row !== "object") {
      continue;
    }
    const turn = harness === "claude" ? claudeTurn(row) : codexTurn(row);
    if (turn !== null) {
      turns.push(turn);
    }
  }
  return turns;
}

function claudeTurn(row: object): ParsedTurn | null {
  const type = Reflect.get(row, "type");
  if (type !== "user" && type !== "assistant" && type !== "message") {
    return null;
  }
  // A sidechain line is a subagent's own conversation, not this session's.
  if (Reflect.get(row, "isSidechain") === true) {
    return null;
  }
  const message = Reflect.get(row, "message");
  if (message === null || typeof message !== "object") {
    return null;
  }
  const role = Reflect.get(message, "role");
  if (role !== "user" && role !== "assistant") {
    return null;
  }
  // `isMeta` marks a line Claude wrote for itself - the resume caveat, a
  // command's expansion - which is not part of the conversation.
  if (role === "user" && Reflect.get(row, "isMeta") === true) {
    return null;
  }
  const text = conversationText(role, Reflect.get(message, "content"));
  return text === null
    ? null
    : { role, text, timestamp: stampOf(Reflect.get(row, "timestamp")) };
}

function codexTurn(row: object): ParsedTurn | null {
  const payload = Reflect.get(row, "payload");
  if (payload === null || typeof payload !== "object") {
    return null;
  }
  if (Reflect.get(payload, "type") !== "message") {
    return null;
  }
  const role = Reflect.get(payload, "role");
  if (role !== "user" && role !== "assistant") {
    return null;
  }
  const text = conversationText(role, Reflect.get(payload, "content"));
  return text === null
    ? null
    : { role, text, timestamp: stampOf(Reflect.get(row, "timestamp")) };
}

/**
 * A message's text, or null when there is nothing of the CONVERSATION in it:
 * an agent turn that was all thinking and tool calls, or a `user` message the
 * harness wrote to itself.
 */
function conversationText(
  role: "user" | "assistant",
  content: unknown,
): string | null {
  const text = messageText(content);
  if (text === null) {
    return null;
  }
  return role === "user" && isHarnessPreamble(text) ? null : text;
}

function stampOf(value: unknown): number {
  if (typeof value !== "string") {
    return 0;
  }
  const at = Date.parse(value);
  return Number.isNaN(at) ? 0 : at;
}

/** The newest turns that fit the bound, still in order. */
function tail(turns: readonly ParsedTurn[]): ParsedTurn[] {
  const kept: ParsedTurn[] = [];
  let chars = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    chars += turns[index].text.length;
    if (chars > MAX_TRANSCRIPT_CHARS && kept.length > 0) {
      break;
    }
    kept.unshift(turns[index]);
  }
  return kept;
}

function titleOf(title: string | null, turns: readonly ParsedTurn[]): string {
  if (title !== null && title.length > 0) {
    return title;
  }
  const first = turns.find((turn) => turn.role === "user");
  if (first === undefined) {
    return "Imported session";
  }
  const line = first.text.split("\n")[0].trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function storedTurn(
  turn: ParsedTurn,
  chatId: string,
  harness: GuiHarnessId,
): StoredTurn {
  return {
    // Derived from the chat and the turn's own place in it, so re-importing
    // the same session writes the same rows rather than duplicates.
    messageId: createHash("sha1")
      .update(`${chatId}:${String(turn.timestamp)}:${turn.text}`)
      .digest("hex"),
    timestamp: turn.timestamp,
    role: turn.role,
    prompt: turn.text,
    fromAgentId: chatId,
    fromTitle: turn.role === "user" ? "" : chatId,
    fromHarnessId: harness,
    expectReply: turn.role === "user",
    responseId: null,
    userId: null,
    // Null is how an assistant turn is already stored; the chat projection
    // builds a document from `prompt` when there is none.
    content: null,
    turnId: null,
  };
}

function chatOf(
  runtime: HostRuntime,
  input: {
    readonly epicId: string;
    readonly chatId: string;
    readonly title: string;
    readonly createdAt: number;
    readonly harness: GuiHarnessId;
    readonly nativeSessionId: string;
    readonly permissionMode: string;
    readonly turns: readonly StoredTurn[];
    readonly truncated: boolean;
  },
): StoredChat {
  return {
    epicId: input.epicId,
    chatId: input.chatId,
    parentId: null,
    hostId: runtime.hostId,
    title: input.title,
    createdAt: input.createdAt,
    // The permission mode the client asked new chats to start under; the
    // source CLI's own model is not a signal, so nothing is read from it.
    runSettings: {
      permissionMode: input.permissionMode,
      harnessId: input.harness,
    },
    // The idempotency key, stored rather than derived: this is what a second
    // import of the same session finds.
    providerSession: {
      harnessId: input.harness,
      sessionId: input.nativeSessionId,
    },
    turns: [...input.turns],
    events: input.truncated
      ? [
          {
            eventId: randomUUID(),
            type: "history.deleted",
            timestamp: Date.now(),
            clientActionId: null,
            actor: null,
            message: TRUNCATED_MESSAGE,
            turnId: null,
            messageId: null,
            queueItemId: null,
            approvalId: null,
            blockId: null,
            severity: "info",
            metadata: null,
          },
        ]
      : [],
    transcriptEpoch: 0,
    indexRevision: 1,
    fileChangeCount: 0,
    lastUsage: null,
    archivedAt: null,
    fastMode: false,
  };
}
