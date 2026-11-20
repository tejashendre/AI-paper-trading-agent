import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AuthGate } from "@/components/AuthGate";
import { Dashboard } from "@/components/Dashboard";
import { isOwnerSession, OWNER_COOKIE } from "@/lib/ownerSession";
import { signIn, signOut } from "./actions";

export const metadata = { robots: { index: false, follow: false } };

export default async function OwnerPage({ searchParams }: { searchParams: Promise<{ invalid?: string; signin?: string }> }) {
  if (isOwnerSession((await cookies()).get(OWNER_COOKIE)?.value)) {
    return <Dashboard owner onLogout={signOut} />;
  }
  const params = await searchParams;
  // The sign-in form appears only when asked for (the Admin Login button).
  // A bookmarked, shared or autocompleted /owner opens the public view instead.
  if (params.signin !== "1" && params.invalid !== "1") redirect("/");
  return <AuthGate action={signIn} invalid={params.invalid === "1"} />;
}
