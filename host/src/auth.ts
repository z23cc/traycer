/**
 * Local-only host auth. The official host verifies a Traycer-cloud JWT
 * against AuthnV3 JWKS. This fork's GUI projects a local session whose
 * bearer is the literal `local` (see gui-app `local-session.ts`). Any
 * non-empty token is accepted so a leftover cloud token also opens.
 */
export function isAcceptedBearer(token: string): boolean {
  return token.length > 0;
}
