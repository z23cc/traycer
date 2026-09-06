export type HostAuthContext = {
  readonly token: string;
  readonly userId: string | null;
};

export function authenticateOpenToken(token: string): HostAuthContext | null {
  if (token.length === 0) {
    return null;
  }
  return {
    token,
    userId: readJwtSubject(token),
  };
}

function readJwtSubject(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (typeof payload.id === "string" && payload.id.length > 0) {
      return payload.id;
    }
    if (typeof payload.sub === "string" && payload.sub.length > 0) {
      return payload.sub;
    }
    return null;
  } catch {
    return null;
  }
}
