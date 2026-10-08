"use client";

import { useRef, useState, type DragEvent } from "react";

/**
 * Drop target plus an explicit "browse" button that opens a hidden file input. The input lives
 * outside any <label> so clicking can never trigger two dialogs or move focus elsewhere.
 */
export function DropZone(props: { accept: string; multiple?: boolean; onFiles: (files: File[]) => void; label: string; hint: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOver(false);
    props.onFiles(Array.from(e.dataTransfer.files));
  };
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={`flex items-center justify-between gap-3 rounded-xl border border-dashed px-4 py-4 transition ${
        over ? "border-nla bg-nla-tint" : "border-[#bdbdbd] bg-mist"
      }`}
    >
      <span className="min-w-0">
        <span className="block text-[14px] text-ink">{props.label}</span>
        <span className="block text-[12px] text-graphite">{props.hint}</span>
      </span>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="h-8 shrink-0 rounded-full border border-nla px-3.5 text-[13px] text-nla transition hover:bg-nla hover:text-white"
      >
        Browse
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={props.accept}
        multiple={props.multiple}
        hidden
        onChange={(e) => {
          props.onFiles(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
    </div>
  );
}

export function FileRow({ name, size, onRemove }: { name: string; size: number; onRemove?: () => void }) {
  return (
    <div className="fade-in flex items-center justify-between gap-3 rounded-lg bg-mist px-3 py-2.5">
      <span className="min-w-0">
        <span className="block truncate text-[14px] text-ink">{name}</span>
        <span className="block text-[12px] text-graphite">{formatSize(size)}</span>
      </span>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove ${name}`} className="grid size-7 shrink-0 place-items-center text-[18px] leading-none text-graphite hover:text-alert">
          ×
        </button>
      )}
    </div>
  );
}

export function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}
