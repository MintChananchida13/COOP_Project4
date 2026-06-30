"use client";

import React, { useState, useMemo } from 'react';
import { Upload, FileText, Clock, CheckCircle2, XCircle, LayoutGrid, Award, Activity, Filter, Image as ImageIcon } from 'lucide-react';

interface RequestItem {
  id: string | number;
  user: string;
  docName: string;
  date: string;
  status: string;
  image?: string | null;
  rois?: any[];
}

interface AdminDashboardProps {
  requests: RequestItem[];
  onSelectRequest: (id: string | number) => void;
  onAddMockRequest?: (newReq: RequestItem) => void;
}

export default function AdminDashboard({ requests, onSelectRequest, onAddMockRequest }: AdminDashboardProps) {
  const [isUploading, setIsUploading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'All' | 'Pending' | 'Approved' | 'Rejected'>('All');
  const [typeFilter, setTypeFilter] = useState<'All' | 'Case 1' | 'Case 2'>('All');

  // 📊 คำนวณสถิติสรุปแบบเรียลไทม์
  const stats = useMemo(() => {
    const totalPending = requests.filter(r => r.status === 'Pending').length;
    const totalApproved = requests.filter(r => r.status === 'Approved').length;
    const totalRejected = requests.filter(r => r.status === 'Rejected').length;
    const total = requests.length;

    // คำนวณอัตราความถูกต้องจำลอง (แปรผันตามจำนวนการอนุมัติ)
    const accuracyRate = total > 0 
      ? (((totalApproved + (totalPending * 0.95)) / (total || 1)) * 100).toFixed(1)
      : "98.2";

    return {
      pending: totalPending,
      approved: totalApproved,
      rejected: totalRejected,
      total,
      accuracy: accuracyRate
    };
  }, [requests]);

  // 🎯 ดักจับกรองประเภทคำขอ
  // Case 1: Template Spec Request (มีกล่อง ROI วาดมาแล้ว)
  // Case 2: New Template Request (ไม่มีกล่อง ROI วาดมา)
  const filteredRequests = useMemo(() => {
    return requests.filter(req => {
      // กรองสถานะ
      const matchStatus = statusFilter === 'All' || req.status === statusFilter;
      
      // กรองประเภทคำขอ
      const isCase1 = req.rois && req.rois.length > 0;
      const matchType = typeFilter === 'All' ||
        (typeFilter === 'Case 1' && isCase1) ||
        (typeFilter === 'Case 2' && !isCase1);

      return matchStatus && matchType;
    });
  }, [requests, statusFilter, typeFilter]);

  // 🎯 อัปโหลดรูปภาพจำลองของแอดมิน
  const handleQuickUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);

    // อ่านภาพเป็น base64
    const reader = new FileReader();
    reader.onload = () => {
      const mockNewRequest: RequestItem = {
        id: "req_" + Date.now(),
        user: "admin_tester@ocr.com",
        docName: file.name,
        date: new Date().toISOString().split('T')[0],
        status: "Pending",
        image: reader.result as string, // เก็บภาพ Base64 จริง
        rois: [] // อาเรย์ว่างสำหรับทดสอบ Case 2
      };

      if (onAddMockRequest) {
        onAddMockRequest(mockNewRequest);
      }
      setIsUploading(false);
      alert(`อัปโหลดไฟล์ ${file.name} เข้าสู่คิวตรวจสอบสำเร็จ (โหมดร้องขอเทมเพลตใหม่)`);
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="space-y-6 animate-fade-in">
      
      {/* 📊 ส่วนที่ 1: สถิติสรุป (Header Stats Cards) */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        
        {/* Total Pending Card */}
        <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-sm flex items-center justify-between transition-all hover:shadow-md">
          <div className="space-y-1">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Total Pending Requests</p>
            <p className="text-2xl font-black text-slate-900">{stats.pending} รายการ</p>
            <p className="text-[10px] text-amber-600 font-semibold flex items-center gap-1">
              <Clock size={10} /> รออนุมัติและลงทะเบียนเทมเพลต
            </p>
          </div>
          <div className="p-3 bg-amber-50 rounded-2xl text-amber-500 border border-amber-100">
            <Clock size={20} strokeWidth={2.5} />
          </div>
        </div>

        {/* Total Registered Card */}
        <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-sm flex items-center justify-between transition-all hover:shadow-md">
          <div className="space-y-1">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Registered Templates</p>
            <p className="text-2xl font-black text-slate-900">{stats.approved} เทมเพลต</p>
            <p className="text-[10px] text-emerald-600 font-semibold flex items-center gap-1">
              <CheckCircle2 size={10} /> บันทึกลงเวกเตอร์สำเร็จ
            </p>
          </div>
          <div className="p-3 bg-emerald-50 rounded-2xl text-emerald-500 border border-emerald-100">
            <LayoutGrid size={20} strokeWidth={2.5} />
          </div>
        </div>

        {/* Accuracy Rate Card */}
        <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-sm flex items-center justify-between transition-all hover:shadow-md">
          <div className="space-y-1">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Estimated Accuracy</p>
            <p className="text-2xl font-black text-indigo-600">{stats.accuracy}%</p>
            <p className="text-[10px] text-slate-400 font-semibold">เฉลี่ยจากข้อมูลการสลักคำและอนุมัติ</p>
          </div>
          <div className="p-3 bg-indigo-50 rounded-2xl text-indigo-500 border border-indigo-100">
            <Award size={20} strokeWidth={2.5} />
          </div>
        </div>

        {/* Recent Activity Card */}
        <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-sm flex items-center justify-between transition-all hover:shadow-md">
          <div className="space-y-1">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Total Handled Queue</p>
            <p className="text-2xl font-black text-slate-900">{stats.total} ทั้งหมด</p>
            <p className="text-[10px] text-indigo-600 font-semibold flex items-center gap-1">
              <Activity size={10} /> อัตราความกระตือรือร้น 100%
            </p>
          </div>
          <div className="p-3 bg-slate-50 rounded-2xl text-slate-400 border border-slate-200">
            <Activity size={20} strokeWidth={2.5} />
          </div>
        </div>
      </div>

      {/* 🌤️ ส่วนต้อนรับและปุ่มอัปโหลดด่วนสำหรับแอดมิน */}
      <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-sm grid grid-cols-1 md:grid-cols-12 gap-6 items-center">
        <div className="md:col-span-8 space-y-1">
          <h2 className="text-lg font-black tracking-tight text-slate-900">
            Template Requests Hub
          </h2>
          <p className="text-xs font-semibold text-slate-500 leading-relaxed">
            รายการร้องขอเทมเพลตใหม่จากผู้ใช้งานเพื่อตรวจสอบความถูกต้อง บันทึกพิกัด ROI และจัดเก็บลงฐานข้อมูล Qdrant Vector
          </p>
        </div>

        <div className="md:col-span-4">
          <label className="relative flex flex-col items-center justify-center border border-dashed border-slate-200 hover:border-indigo-500 hover:bg-indigo-50/10 rounded-xl py-3 px-4 text-center cursor-pointer transition-all group">
            <input 
              type="file" 
              accept="image/*,.pdf" 
              className="hidden" 
              onChange={handleQuickUpload}
              disabled={isUploading}
            />
            <Upload className="w-4 h-4 text-slate-400 group-hover:text-indigo-600 mb-1 transition-colors" />
            <span className="text-xs font-bold text-slate-700 group-hover:text-indigo-600 transition-colors">
              {isUploading ? "กำลังเตรียมภาพตัวอย่าง..." : "แอดมินอัปโหลดไฟล์ทดสอบด่วน"}
            </span>
          </label>
        </div>
      </div>

      {/* 📊 ส่วนที่ 2: Filter Panel & Table */}
      <div className="bg-white border border-slate-200/80 rounded-2xl shadow-sm overflow-hidden space-y-4 py-4">
        
        {/* Filter Panel */}
        <div className="px-6 flex flex-col sm:flex-row gap-4 items-center justify-between border-b border-slate-100 pb-4">
          <div className="flex items-center gap-2 text-xs font-bold text-slate-700">
            <Filter size={14} className="text-slate-400" />
            <span>กรองข้อมูลแถวแสดงผล:</span>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            
            {/* Status Filter */}
            <div className="flex bg-slate-100 p-0.5 rounded-lg border border-slate-200/40 text-[10px] font-bold text-slate-600">
              {(['All', 'Pending', 'Approved', 'Rejected'] as const).map((status) => (
                <button
                  key={status}
                  type="button"
                  onClick={() => setStatusFilter(status)}
                  className={`px-3 py-1.5 rounded-md transition-all ${statusFilter === status ? 'bg-white text-indigo-600 shadow-sm' : 'hover:text-slate-900'}`}
                >
                  {status}
                </button>
              ))}
            </div>

            {/* Type Filter */}
            <div className="flex bg-slate-100 p-0.5 rounded-lg border border-slate-200/40 text-[10px] font-bold text-slate-600">
              {(['All', 'Case 1', 'Case 2'] as const).map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setTypeFilter(type)}
                  className={`px-3 py-1.5 rounded-md transition-all ${typeFilter === type ? 'bg-white text-indigo-600 shadow-sm' : 'hover:text-slate-900'}`}
                >
                  {type === 'All' ? 'ทุกประเภท' : type === 'Case 1' ? 'Case 1: มี ROI' : 'Case 2: เทมเพลตใหม่'}
                </button>
              ))}
            </div>

          </div>
        </div>

        {/* Table View */}
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50/70 border-b border-slate-200/60 text-[11px] font-black text-slate-500 uppercase tracking-wider">
                <th className="px-6 py-3 w-[10%]">Thumbnail</th>
                <th className="px-6 py-3 w-[15%]">Request ID</th>
                <th className="px-6 py-3 w-[20%]">Document Spec</th>
                <th className="px-6 py-3 w-[20%]">Request Type</th>
                <th className="px-6 py-3 w-[15%]">Requested By</th>
                <th className="px-6 py-3 w-[10%]">Status</th>
                <th className="px-6 py-3 w-[10%] text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs font-semibold text-slate-700">
              {filteredRequests.map((req) => {
                const isCase1 = req.rois && req.rois.length > 0;
                return (
                  <tr key={req.id} className="hover:bg-slate-50/50 transition-colors">
                    
                    {/* Thumbnail Column */}
                    <td className="px-6 py-3">
                      <div className="w-10 h-12 bg-slate-100 border border-slate-200 rounded-lg overflow-hidden flex items-center justify-center shadow-sm shrink-0">
                        {(() => {
                          if (!req.image) return <ImageIcon size={16} className="text-slate-400" />;
                          let imageUrl = req.image;
                          if (req.image.startsWith('[')) {
                            try {
                              const parsed = JSON.parse(req.image);
                              if (Array.isArray(parsed) && parsed.length > 0) {
                                imageUrl = parsed[0];
                              }
                            } catch (e) {
                              console.error("Failed to parse thumbnail image JSON:", e);
                            }
                          }
                          return <img src={imageUrl} alt="Thumbnail" className="w-full h-full object-cover" />;
                        })()}
                      </div>
                    </td>

                    {/* Request ID */}
                    <td className="px-6 py-4 font-mono font-bold text-slate-400">
                      {typeof req.id === 'string' && req.id.startsWith('req_') ? `#${req.id.slice(0,10)}...` : `#${req.id}`}
                    </td>

                    {/* Document Spec */}
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2 font-bold text-slate-800">
                        <FileText size={14} className="text-slate-400 shrink-0" />
                        <span className="truncate max-w-[150px]" title={req.docName}>{req.docName}</span>
                      </div>
                    </td>

                    {/* Request Type */}
                    <td className="px-6 py-4">
                      {isCase1 ? (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-md bg-blue-50 text-blue-700 border border-blue-100">
                          Case 1: Spec ROI ({req.rois?.length} Fields)
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-md bg-amber-50 text-amber-700 border border-amber-100">
                          Case 2: Request New Type
                        </span>
                      )}
                    </td>

                    {/* Requested By */}
                    <td className="px-6 py-4 text-slate-500 font-mono text-[11px]">{req.user}</td>

                    {/* Status */}
                    <td className="px-6 py-4">
                      {req.status === 'Pending' && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200/50">
                          <Clock size={11} /> Pending
                        </span>
                      )}
                      {req.status === 'Approved' && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200/50">
                          <CheckCircle2 size={11} /> Approved
                        </span>
                      )}
                      {req.status === 'Rejected' && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200/50">
                          <XCircle size={11} /> Rejected
                        </span>
                      )}
                    </td>

                    {/* Action Button */}
                    <td className="px-6 py-4 text-center">
                      <button
                        type="button"
                        onClick={() => onSelectRequest(req.id)}
                        className="px-3.5 py-1.5 font-black bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl shadow-sm hover:shadow transition-all text-[11px] active:scale-98"
                      >
                        Review
                      </button>
                    </td>

                  </tr>
                );
              })}
              
              {filteredRequests.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center py-16 text-slate-400 font-semibold bg-slate-50/30">
                    ไม่พบรายการคำขอตรงตามเงื่อนไขที่เลือก
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}