"use client";

import React, { useState } from 'react';
import { Upload, FileText, Clock, CheckCircle2, XCircle } from 'lucide-react';

interface AdminDashboardProps {
  requests: any[];
  onSelectRequest: (id: number) => void;
  onAddMockRequest?: (newReq: any) => void; // 💡 พร็อพใหม่สำหรับเพิ่มข้อมูลเข้าตาราง
}

export default function AdminDashboard({ requests, onSelectRequest, onAddMockRequest }: AdminDashboardProps) {
  const [isUploading, setIsUploading] = useState(false);

  // 🎯 ฟังก์ชันเมื่อแอดมินเลือกอัปโหลดไฟล์เพื่อทดสอบระบบ (ไม่ต้องตีกรอบ)
  const handleQuickUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);

    // จำลองการโหลดเซิร์ฟเวอร์แป๊บหนึ่ง 1 วินาที
    setTimeout(() => {
      const mockNewRequest = {
        id: Date.now(), // ใช้ timestamp เป็น ID จำลอง
        user: "admin_tester@ocr.com",
        docName: file.name,
        date: new Date().toISOString().split('T')[0],
        status: "Pending",
        image: null, // ไม่มีรูปภาพ/พิกัด ก็รันได้
        rois: []    // อาเรย์ว่างสำหรับทดสอบระบบแบบไม่ตีกรอบ
      };

      if (onAddMockRequest) {
        onAddMockRequest(mockNewRequest);
      }
      setIsUploading(false);
      alert(`📥 อัปโหลดไฟล์ ${file.name} เข้าสู่คิวตรวจสอบของแอดมินสำเร็จ!`);
    }, 1000);
  };

  return (
    <div className="space-y-6">
      {/* 🌤️ ส่วนบน: หัวข้อ และ กล่องอัปโหลดด่วนสำหรับแอดมิน (โทนคลีนสว่าง) */}
      <div className="bg-white border border-slate-200/80 rounded-2xl p-6 shadow-sm grid grid-cols-1 md:grid-cols-12 gap-6 items-center">
        <div className="md:col-span-7 space-y-1.5">
          <h2 className="text-xl font-extrabold tracking-tight text-slate-900">
            Template Requests Dashboard
          </h2>
          <p className="text-xs font-medium text-slate-500 leading-relaxed">
            รายการคำขอสร้าง/แก้ไขโครงสร้างเทมเพลต เพื่อนำไปตรวจสอบและจัดเก็บลงระบบเวกเตอร์ฐานข้อมูล
          </p>
        </div>

        {/* 📥 ส่วนกล่องอัปโหลดไฟล์ของ Admin */}
        <div className="md:col-span-5">
          <label className="relative flex flex-col items-center justify-center border-2 border-dashed border-slate-200 hover:border-indigo-500 hover:bg-slate-50/50 rounded-xl py-4 px-4 text-center cursor-pointer transition-all group">
            <input 
              type="file" 
              accept="image/*,.pdf" 
              className="hidden" 
              onChange={handleQuickUpload}
              disabled={isUploading}
            />
            <Upload className="w-5 h-5 text-slate-400 group-hover:text-indigo-600 mb-1.5 transition-colors" />
            <span className="text-xs font-bold text-slate-700 group-hover:text-indigo-600 transition-colors">
              {isUploading ? "กำลังประมวลผลไฟล์..." : "แอดมินอัปโหลดไฟล์ทดสอบด่วน"}
            </span>
            <span className="text-[10px] text-slate-400 mt-0.5">ไม่ต้องตีกรอบ ระบบจะข้ามไปขั้นบันทึกได้เลย</span>
          </label>
        </div>
      </div>

      {/* 📊 ส่วนล่าง: ตารางคิวงาน (โทนคลีนสว่าง) */}
      <div className="bg-white border border-slate-200/80 rounded-2xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                <th className="px-6 py-3.5">Request ID</th>
                <th className="px-6 py-3.5">User</th>
                <th className="px-6 py-3.5">Document Spec</th>
                <th className="px-6 py-3.5">Date Submitted</th>
                <th className="px-6 py-3.5">Status</th>
                <th className="px-6 py-3.5 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs font-medium text-slate-700">
              {requests.map((req) => (
                <tr key={req.id} className="hover:bg-slate-50/60 transition-colors">
                  <td className="px-6 py-4 font-mono font-bold text-slate-400">#{req.id}</td>
                  <td className="px-6 py-4">{req.user}</td>
                  <td className="px-6 py-4 flex items-center gap-2 font-semibold text-slate-800">
                    <FileText size={14} className="text-slate-400" />
                    {req.docName}
                  </td>
                  <td className="px-6 py-4 text-slate-500">{req.date}</td>
                  <td className="px-6 py-4">
                    {req.status === 'Pending' && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200/60">
                        <Clock size={12} /> Pending
                      </span>
                    )}
                    {req.status === 'Approved' && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200/60">
                        <CheckCircle2 size={12} /> Approved
                      </span>
                    )}
                    {req.status === 'Rejected' && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200/60">
                        <XCircle size={12} /> Rejected
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-center">
                    <button
                      type="button"
                      onClick={() => onSelectRequest(req.id)}
                      className="px-4 py-2 font-bold bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl shadow-sm hover:shadow transition-all text-[11px] active:scale-98"
                    >
                      Review Request
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}