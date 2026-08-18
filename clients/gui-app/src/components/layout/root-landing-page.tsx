import { AuthLandingPage } from "@/components/auth/auth-landing-page";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * Root index route body.
 *
 * Signed-out users land on the auth-first desktop welcome surface. In this
 * fork `AuthService` projects a local session on start, so that wall is
 * skipped unless a test (or an explicit sign-out) leaves the store signed
 * out. Once signed in, `/` is the normal landing workspace; the surrounding
 * `LocalHostGate` still blocks the composer until the desktop's local host
 * is ready.
 */
export function RootLandingPage() {
  const status = useAuthStore((state) => state.status);

  if (status !== "signed-in") {
    return <AuthLandingPage />;
  }

  return null;
}
