"use client"
import React, { useState, useEffect } from "react";
import { Lock } from "lucide-react";

export function createAuthFetch(secret: string) {
  return async (url: string, init?: RequestInit) => {
    return fetch(url, {
      ...init,
      headers: { ...init?.headers, 'Authorization': `Bearer ${secret}` },
    });
  };
}

export function AuthGate({ children }: { children: (secret: string) => React.ReactNode }) {
  const [secret, setSecret] = useState<string | null>(null);
  const [input, setInput] = useState("");

  useEffect(() => {
    const saved = localStorage.getItem("dashboard_secret");
    if (saved) setSecret(saved);
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim()) {
      localStorage.setItem("dashboard_secret", input.trim());
      setSecret(input.trim());
    }
  };

  const handleSpectator = () => {
    localStorage.setItem("dashboard_secret", "SPECTATOR");
    setSecret("SPECTATOR");
  };

  if (secret) {
    return <>{children(secret)}</>;
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#050505] p-4">
      <div className="bg-[#0f0f0f] border border-[#262626] rounded-xl p-8 max-w-md w-full shadow-2xl">
        <div className="flex justify-center mb-6">
          <div className="w-16 h-16 bg-neutral-900 rounded-full flex items-center justify-center border border-neutral-800 glow-orange">
            <Lock className="text-orange-500" size={32} />
          </div>
        </div>
        <h2 className="text-2xl font-bold text-center mb-2">Quant Dashboard</h2>
        <p className="text-neutral-500 text-center mb-6">Enter your dashboard secret to access the trading terminal.</p>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <input
              type="password"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Enter Dashboard Secret"
              className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-orange-500 transition"
              autoFocus
            />
          </div>
          <button
            type="submit"
            className="w-full bg-orange-600 hover:bg-orange-700 text-white font-medium rounded-lg px-4 py-3 transition"
          >
            Access Terminal
          </button>
        </form>

        <div className="relative flex py-4 items-center">
          <div className="flex-grow border-t border-[#262626]"></div>
          <span className="flex-shrink mx-4 text-neutral-600 text-xs font-mono">OR</span>
          <div className="flex-grow border-t border-[#262626]"></div>
        </div>

        <button
          onClick={handleSpectator}
          className="w-full bg-neutral-900 border border-[#262626] hover:bg-neutral-800 text-neutral-300 font-medium rounded-lg px-4 py-3 transition text-sm font-mono"
        >
          ENTER AS SPECTATOR (READ-ONLY)
        </button>
      </div>
    </div>
  );
}
