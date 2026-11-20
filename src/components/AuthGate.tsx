import Link from "next/link";
import { Lock } from "lucide-react";

export function AuthGate({ action, invalid }: { action: (form: FormData) => Promise<void>; invalid: boolean }) {
  return (
    <main className="min-h-[100dvh] flex items-center justify-center bg-[#050505] px-4 py-8 text-white">
      <div className="w-full max-w-md rounded-xl border border-neutral-800 bg-[#0f0f0f] p-6 sm:p-8">
        <Lock className="mx-auto mb-4 text-orange-500" aria-hidden />
        <h1 className="mb-6 text-center text-2xl font-bold">Owner sign-in</h1>
        <form action={action} className="space-y-4">
          <label htmlFor="owner-secret" className="block text-sm">Dashboard secret</label>
          <input id="owner-secret" name="secret" type="password" autoComplete="current-password" required
            autoCapitalize="none" autoCorrect="off" spellCheck={false}
            className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-3 text-base focus-visible:outline-orange-500" />
          {invalid && <p role="alert" className="text-sm text-red-400">Incorrect dashboard secret.</p>}
          <button type="submit" className="w-full min-h-[44px] rounded-lg bg-orange-700 px-4 py-3 font-medium hover:bg-orange-800">
            Sign in
          </button>
        </form>

        <div className="flex items-center py-4" aria-hidden>
          <div className="flex-grow border-t border-neutral-800" />
          <span className="mx-4 text-xs font-mono text-neutral-600">OR</span>
          <div className="flex-grow border-t border-neutral-800" />
        </div>

        {/* A visible exit, so it works on phones and home-screen shortcuts with no URL bar. */}
        <Link href="/" className="flex w-full min-h-[44px] flex-col items-center justify-center text-center rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3 font-mono text-sm text-neutral-300 hover:bg-neutral-800">
          VIEW AS SPECTATOR
          <span className="text-[10px] text-neutral-500">read-only, no sign-in</span>
        </Link>
      </div>
    </main>
  );
}
