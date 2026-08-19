"use client";

import { FormEvent, Suspense, useMemo, useState } from "react";
import { Eye, EyeOff, Lock, Mail, ShieldCheck } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { mockAccounts, writeAuthSession } from "../../auth/session";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const nextPath = useMemo(() => searchParams.get("next") || "", [searchParams]);

  const handleLogin = async (event: FormEvent) => {
    event.preventDefault();
    setIsLoading(true);
    setError("");

    window.setTimeout(() => {
      const account = mockAccounts.find(
        (item) => item.email.toLowerCase() === email.trim().toLowerCase() && item.password === password
      );
      setIsLoading(false);
      if (!account) {
        setError("อีเมลหรือรหัสผ่านไม่ถูกต้อง");
        return;
      }

      writeAuthSession({ id: account.id, userId: account.id, email: account.email, role: account.role, name: account.name });
      const fallbackPath = account.role === "admin" ? "/admin" : "/";
      const safeNext =
        nextPath &&
        nextPath.startsWith("/") &&
        !nextPath.startsWith("//") &&
        (account.role === "admin" || !nextPath.startsWith("/admin"))
          ? nextPath
          : fallbackPath;
      router.replace(safeNext);
    }, 250);
  };
  return (
    <div className="flex min-h-screen flex-col justify-center bg-slate-100 px-4 py-12 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-blue-600 text-white shadow-md">
          <ShieldCheck size={28} />
        </div>
        <h1 className="mt-6 text-3xl font-extrabold text-slate-900">OCR Studio</h1>
        <p className="mt-2 text-sm font-semibold text-slate-600">à¹€à¸‚à¹‰à¸²à¸ªà¸¹à¹ˆà¸£à¸°à¸šà¸šà¹€à¸žà¸·à¹ˆà¸­à¹ƒà¸Šà¹‰à¸‡à¸²à¸™ OCR à¹à¸¥à¸°à¸ˆà¸±à¸”à¸à¸²à¸£ Template</p>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-8 shadow sm:px-10">
          <form className="space-y-6" onSubmit={handleLogin}>
            <label className="block">
              <span className="text-sm font-bold text-slate-700">à¸­à¸µà¹€à¸¡à¸¥</span>
              <div className="relative mt-1 rounded-md shadow-sm">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-slate-400">
                  <Mail size={18} />
                </div>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="user@ocr.com"
                  className="block w-full rounded-lg border border-slate-300 bg-slate-50 py-2 pl-10 pr-3 text-sm transition-colors focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </label>

            <label className="block">
              <span className="text-sm font-bold text-slate-700">à¸£à¸«à¸±à¸ªà¸œà¹ˆà¸²à¸™</span>
              <div className="relative mt-1 rounded-md shadow-sm">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-slate-400">
                  <Lock size={18} />
                </div>
                <input
                  type={showPassword ? "text" : "password"}
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="password"
                  className="block w-full rounded-lg border border-slate-300 bg-slate-50 py-2 pl-10 pr-10 text-sm transition-colors focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((current) => !current)}
                  className="absolute inset-y-0 right-0 flex items-center pr-3 text-slate-400 hover:text-slate-600"
                  aria-label={showPassword ? "à¸‹à¹ˆà¸­à¸™à¸£à¸«à¸±à¸ªà¸œà¹ˆà¸²à¸™" : "à¹à¸ªà¸”à¸‡à¸£à¸«à¸±à¸ªà¸œà¹ˆà¸²à¸™"}
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </label>

            {error && <div className="rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs font-bold text-red-600">{error}</div>}

            <button
              type="submit"
              disabled={isLoading}
              className="flex w-full justify-center rounded-lg border border-transparent bg-blue-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {isLoading ? "à¸à¸³à¸¥à¸±à¸‡à¹€à¸‚à¹‰à¸²à¸ªà¸¹à¹ˆà¸£à¸°à¸šà¸š..." : "à¹€à¸‚à¹‰à¸²à¸ªà¸¹à¹ˆà¸£à¸°à¸šà¸š"}
            </button>
          </form>

          <div className="mt-6 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs font-semibold text-slate-600">
            <p className="font-black text-slate-800">à¸šà¸±à¸à¸Šà¸µà¸—à¸”à¸ªà¸­à¸š</p>
            <p className="mt-1">User: user@ocr.com / user123</p>
            <p>Admin: admin@ocr.com / admin123</p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-slate-100 px-6 text-sm font-semibold text-slate-500">
          à¸à¸³à¸¥à¸±à¸‡à¹€à¸›à¸´à¸”à¸«à¸™à¹‰à¸²à¹€à¸‚à¹‰à¸²à¸ªà¸¹à¹ˆà¸£à¸°à¸šà¸š...
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
