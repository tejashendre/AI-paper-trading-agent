import { Lock } from "lucide-react";

export function AuthGate({ action, invalid }: { action: (form: FormData) => Promise<void>; invalid: boolean }) {
  return (
    <main className="min-h-screen flex items-center justify-center bg-[#050505] p-4 text-white">
      <div className="w-full max-w-md rounded-xl border border-neutral-800 bg-[#0f0f0f] p-8">
        <Lock className="mx-auto mb-4 text-orange-500" aria-hidden />
        <h1 className="mb-6 text-center text-2xl font-bold">Owner sign-in</h1>
        <form action={action} className="space-y-4">
          <label htmlFor="owner-secret" className="block text-sm">Dashboard secret</label>
          <input id="owner-secret" name="secret" type="password" autoComplete="current-password" required
            className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-3 focus-visible:outline-orange-500" />
          {invalid && <p role="alert" className="text-sm text-red-400">Incorrect dashboard secret.</p>}
          <button type="submit" className="w-full rounded-lg bg-orange-700 px-4 py-3 font-medium hover:bg-orange-800">
            Sign in
          </button>
        </form>
      </div>
    </main>
  );
}
