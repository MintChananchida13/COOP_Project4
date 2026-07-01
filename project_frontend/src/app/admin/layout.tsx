import { ReactNode } from "react";
import AdminShell from "../../admin/AdminShell";
import { AdminStateProvider } from "../../admin/AdminState";

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <AdminStateProvider>
      <AdminShell>{children}</AdminShell>
    </AdminStateProvider>
  );
}
