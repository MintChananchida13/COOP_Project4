import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OCR Template Studio",
  description: "Advanced Document Processing and Verification Studio",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
