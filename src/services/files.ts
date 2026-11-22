import { formatForExtension } from '../engines/catalog';
import type { FormatId } from '../types/formats';
import { isProbablyBinary, toHex } from '../utils/bytes';

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_BINARY_BYTES = 8 * 1024 * 1024;

export interface ImportedFile {
  name: string;
  text: string;
  size: number;
  /** The file was binary; `text` holds its hexadecimal representation. */
  binary: boolean;
  formatHint: FormatId | null;
  warning?: string;
}

/** Read a dropped/selected file. Binary files become hex text for the BSON/MessagePack modules. */
export async function importFile(file: File): Promise<ImportedFile> {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  }
  const buf = new Uint8Array(await file.arrayBuffer());
  const hint = formatForExtension(file.name);
  const binaryByExt = hint === 'bson' || hint === 'msgpack';
  if (binaryByExt || isProbablyBinary(buf)) {
    if (buf.length > MAX_BINARY_BYTES) throw new Error(`Binary files are limited to ${MAX_BINARY_BYTES / 1024 / 1024} MB.`);
    let formatHint: FormatId | null = hint;
    if (!formatHint && buf.length >= 5) {
      const size = buf[0] | (buf[1] << 8) | (buf[2] << 16) | (buf[3] << 24);
      formatHint = size > 4 && size <= buf.length && buf[size - 1] === 0 ? 'bson' : 'msgpack';
    }
    return { name: file.name, text: toHex(buf), size: file.size, binary: true, formatHint, warning: `Binary file shown as hexadecimal (${buf.length} bytes).` };
  }
  let text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { name: file.name, text, size: file.size, binary: false, formatHint: hint };
}

export function downloadBlob(data: BlobPart, fileName: string, mime: string): void {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}

export async function readClipboard(): Promise<string> {
  if (!navigator.clipboard?.readText) throw new Error('Clipboard access is not available in this browser. Use Ctrl+V in the editor.');
  return navigator.clipboard.readText();
}
