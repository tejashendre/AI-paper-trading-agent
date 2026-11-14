import { cookies } from "next/headers";
import { AuthGate } from "@/components/AuthGate";
import { Dashboard } from "@/components/Dashboard";
import { isOwnerSession, OWNER_COOKIE } from "@/lib/ownerSession";
import { signIn, signOut } from "./actions";

export const metadata = { robots: { index: false, follow: false } };

export default async function OwnerPage({ searchParams }: { searchParams: Promise<{ invalid?: string }> }) {
  if (isOwnerSession((await cookies()).get(OWNER_COOKIE)?.value)) {
    return <Dashboard owner onLogout={signOut} />;
  }
  return <AuthGate action={signIn} invalid={(await searchParams).invalid === "1"} />;
}
