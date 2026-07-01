"use client";

import Link from "next/link";
import { ReactNode } from "react";

const navItems = [
  { href: "/admin", label: "Dashboard" },
  { href: "/admin/requests", label: "Requests" },
  { href: "/admin/templates", label: "Templates" },
  { href: "/", label: "OCR Studio" },
];

export default function AdminShell({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-screen bg-slate-50 py-8">
      <div className="mx-auto max-w-7xl px-6 space-y-6">
        <header className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-2xl font-black text-slate-900">Admin Template Management</h1>
            <p className="text-xs font-semibold text-slate-500">Review requests, manage templates, and prepare layout embeddings.</p>
          </div>
          <nav className="flex flex-wrap gap-2">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-black text-slate-700 hover:bg-slate-50 hover:text-indigo-700"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </header>
        {children}
      </div>
    </main>
  );
}
