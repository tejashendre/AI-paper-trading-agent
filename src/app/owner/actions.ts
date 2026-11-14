"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createOwnerSession, matchesOwnerSecret, OWNER_COOKIE, OWNER_SESSION_SECONDS } from "@/lib/ownerSession";

export async function signIn(form: FormData) {
  const secret = form.get("secret");
  if (typeof secret !== "string" || !matchesOwnerSecret(secret.trim())) redirect("/owner?invalid=1");
  (await cookies()).set(OWNER_COOKIE, createOwnerSession(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: OWNER_SESSION_SECONDS,
  });
  redirect("/owner");
}

export async function signOut() {
  (await cookies()).delete(OWNER_COOKIE);
  redirect("/");
}
