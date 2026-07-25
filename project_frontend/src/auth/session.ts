"use client";

export type AuthRole = "user" | "admin";

export interface AuthSession {
  email: string;
  role: AuthRole;
  name: string;
}

export const AUTH_SESSION_KEY = "ocr-studio:auth-session";
export const AUTH_COOKIE_NAME = "ocr_role";

export const demoAccounts: Array<AuthSession & { password: string }> = [
  { email: "user@ocr.com", password: "user123", role: "user", name: "User" },
  { email: "admin@ocr.com", password: "admin123", role: "admin", name: "Admin" },
];

export const readAuthSession = (): AuthSession | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(AUTH_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AuthSession>;
    if ((parsed.role === "user" || parsed.role === "admin") && parsed.email) {
      return {
        email: parsed.email,
        role: parsed.role,
        name: parsed.name || parsed.email,
      };
    }
  } catch {
    return null;
  }
  return null;
};

export const writeAuthSession = (session: AuthSession) => {
  window.localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(session));
  document.cookie = `${AUTH_COOKIE_NAME}=${session.role}; path=/; max-age=604800; SameSite=Lax`;
};

export const clearAuthSession = () => {
  window.localStorage.removeItem(AUTH_SESSION_KEY);
  document.cookie = `${AUTH_COOKIE_NAME}=; path=/; max-age=0; SameSite=Lax`;
};

