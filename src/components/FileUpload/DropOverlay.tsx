import { FileUp } from 'lucide-react';

export function DropOverlay() {
  return (
    <div className="pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-accent bg-bg/80 text-center backdrop-blur-sm">
      <FileUp size={28} className="text-accent" />
      <div className="text-[14px] font-semibold text-text">Drop a file to open it</div>
      <div className="max-w-xs text-[12px] text-muted">Text files are opened as-is; binary files (BSON, MessagePack) are shown as hexadecimal. Files stay on your device.</div>
    </div>
  );
}
