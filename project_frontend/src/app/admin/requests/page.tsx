"use client";

import React, { useState } from 'react';
import AdminDashboard from '@/admin//AdminDashboard';
import AdminReviewZone from '@/admin//AdminReviewZone';

interface RequestItem {
  id: number;
  user: string;
  docName: string;
  date: string;
  status: string;
}

export default function AdminPage() {
  const [view, setView] = useState<'dashboard' | 'review'>('dashboard');
  const [selectedRequestId, setSelectedRequestId] = useState<number | null>(null);

  // ข้อมูลจำลองสำหรับทดสอบ
  const [requests, setRequests] = useState<RequestItem[]>([
    { id: 101, user: "John Doe", docName: "Invoice_CompanyA.pdf", date: "2026-06-24", status: "Pending" },
    { id: 102, user: "Jane Smith", docName: "Receipt_Fuel.jpg", date: "2026-06-23", status: "Pending" },
  ]);

  const handleSelectRequest = (id: number) => {
    setSelectedRequestId(id);
    setView('review');
  };

  const handleBackToDashboard = () => {
    setView('dashboard');
    setSelectedRequestId(null);
  };

  const handleUpdateStatus = (id: number, nextStatus: 'Approved' | 'Rejected') => {
    setRequests(prev => prev.map(req => req.id === id ? { ...req, status: nextStatus } : req));
    setView('dashboard');
  };

const renderContent = () => {
    if (view === 'dashboard') {
      const DashboardComp = AdminDashboard as any;
      return (
        <DashboardComp 
          requests={requests} 
          onSelectRequest={handleSelectRequest} 
          // 💡 เพิ่มฟังก์ชันนี้เพื่อรับค่าจากปุ่มอัปโหลดด่วนเข้าตารางหลัก
          onAddMockRequest={(newReq: any) => setRequests(prev => [newReq, ...prev])} 
        />
      );
    }
    
    const ReviewComp = AdminReviewZone as any;
    return (
      <ReviewComp 
        requestId={selectedRequestId} 
        onBack={handleBackToDashboard}
        onResolveStatus={handleUpdateStatus}
      />
    );
  };

return (
    <div className="min-h-screen bg-slate-50 text-slate-950 font-sans selection:bg-indigo-600 selection:text-white antialiased">
      {/* Header โทนสว่าง คลีน มินิมอล */}
      <header className="border-b border-slate-200/80 bg-white/80 backdrop-blur-md sticky top-0 z-50 shadow-sm">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-2.5 h-2.5 rounded-full bg-indigo-600 shadow-sm shadow-indigo-600/30 animate-pulse" />
            <h1 className="text-xs font-bold tracking-wider text-slate-700 uppercase">
              Intelligent OCR <span className="text-indigo-600">:: Admin Settings</span>
            </h1>
          </div>
          <div className="text-[11px] font-bold text-slate-500 bg-slate-100 border border-slate-200/60 px-3 py-1 rounded-full uppercase tracking-wider">
            Role: Super Admin
          </div>
        </div>
      </header>

      {/* Main Content พื้นหลังโปร่งโล่งสบายตา */}
      <main className="max-w-7xl mx-auto p-6 space-y-5">
        {renderContent()}
      </main>
    </div>
  );
}