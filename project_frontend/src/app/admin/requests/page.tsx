"use client";

import React, { useState, useEffect } from 'react';
import AdminDashboard from '@/admin/AdminDashboard';
import AdminReviewZone from '@/admin/AdminReviewZone';

interface RequestItem {
  id: string | number;
  user: string;
  docName: string;
  date: string;
  status: string;
  image?: string | null;
  rois?: any[];
}

export default function AdminPage() {
  const [view, setView] = useState<'dashboard' | 'review'>('dashboard');
  const [selectedRequestId, setSelectedRequestId] = useState<string | number | null>(null);
  const [requests, setRequests] = useState<RequestItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  // ดึงคำขอเทมเพลตทั้งหมดจาก SQLite
  const fetchRequests = async () => {
    try {
      setIsLoading(true);
      const res = await fetch("/api/ocr");
      const json = await res.json();
      if (json.success) {
        const dbRequests = json.data.map((req: any) => ({
          id: req.id,
          user: "user@ocr.com", // ผู้ส่งคำขอจำลอง
          docName: req.documentName,
          date: new Date(req.createdAt).toISOString().split('T')[0],
          status: req.status === "PENDING" ? "Pending" : req.status === "APPROVED" ? "Approved" : "Rejected",
          image: req.imageUrl,
          rois: req.roiFields ? req.roiFields.map((f: any) => ({
            id: f.id,
            fieldName: f.fieldName,
            x: f.x,
            y: f.y,
            width: f.width,
            height: f.height,
            type: f.type,
            dataType: f.dataType,
            role: f.role,
            verificationRule: f.verificationRule,
            pageIndex: f.pageIndex,
            points: f.points ? JSON.parse(f.points) : undefined
          })) : []
        }));

        // ข้อมูลจำลองเพิ่มเติมสำหรับแสดงผล
        const mocks = [
          { id: 101, user: "John Doe", docName: "Invoice_CompanyA.pdf", date: "2026-06-24", status: "Pending", image: null, rois: [] },
          { id: 102, user: "Jane Smith", docName: "Receipt_Fuel.jpg", date: "2026-06-23", status: "Pending", image: null, rois: [] },
        ];

        setRequests([...dbRequests, ...mocks]);
      }
    } catch (err) {
      console.error("Error fetching requests:", err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchRequests();
  }, []);

  const handleSelectRequest = (id: string | number) => {
    setSelectedRequestId(id);
    setView('review');
  };

  const handleBackToDashboard = () => {
    setView('dashboard');
    setSelectedRequestId(null);
  };

  const handleUpdateStatus = async (id: string | number, nextStatus: 'Approved' | 'Rejected') => {
    if (typeof id === 'string') {
      try {
        const response = await fetch(`/api/ocr?id=${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: nextStatus })
        });
        if (!response.ok) {
          alert("ไม่สามารถอัปเดตสถานะในฐานข้อมูลได้");
        }
      } catch (err) {
        console.error("Error updating request status:", err);
      }
    }

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
          onAddMockRequest={(newReq: any) => setRequests(prev => [newReq, ...prev])} 
        />
      );
    }
    
    const ReviewComp = AdminReviewZone as any;
    const selectedRequest = requests.find(r => r.id === selectedRequestId);
    
    return (
      <ReviewComp 
        requestId={selectedRequestId} 
        requestData={selectedRequest}
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