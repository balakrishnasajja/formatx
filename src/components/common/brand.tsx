import { Binary, Braces, Brackets, Code, CodeXml, Coffee, Database, FileCode, FileJson, FileText, Hash, Network, Palette, Settings2, ShieldCheck, Sheet, Terminal, Type, Variable, Webhook, Workflow } from 'lucide-react';
import type { FormatCategory, FormatId } from '../../types/formats';

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role="img" aria-label="FormatX logo">
      <defs>
        <linearGradient id="fx-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--accent)" />
          <stop offset="1" stopColor="var(--accent-2)" />
        </linearGradient>
      </defs>
      <rect x="1.5" y="1.5" width="29" height="29" rx="8" fill="url(#fx-g)" opacity="0.16" stroke="url(#fx-g)" strokeWidth="1.5" />
      <path d="M11.5 9 C8.5 9 9.5 15 7.5 16 C9.5 17 8.5 23 11.5 23" fill="none" stroke="url(#fx-g)" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M20.5 9 C23.5 9 22.5 15 24.5 16 C22.5 17 23.5 23 20.5 23" fill="none" stroke="url(#fx-g)" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M13.6 12.6 L18.4 19.4 M18.4 12.6 L13.6 19.4" stroke="var(--text)" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

const ICONS: Partial<Record<FormatId, typeof Braces>> = {
  json: Braces,
  jsonc: Braces,
  json5: Braces,
  xml: CodeXml,
  yaml: FileText,
  toml: Settings2,
  csv: Sheet,
  tsv: Sheet,
  ini: Settings2,
  env: Variable,
  properties: Coffee,
  html: CodeXml,
  css: Palette,
  scss: Palette,
  javascript: FileCode,
  typescript: FileCode,
  markdown: Type,
  php: Code,
  python: Terminal,
  java: Coffee,
  sql: Database,
  graphql: Network,
  openapi: Webhook,
  jsonschema: ShieldCheck,
  bson: Binary,
  msgpack: Binary,
  protobuf: Workflow,
};

export function FormatIcon({ id, size = 14, className }: { id: FormatId | null | undefined; size?: number; className?: string }) {
  const Icon = (id && ICONS[id]) || Hash;
  return <Icon size={size} className={className} aria-hidden />;
}

export const CATEGORY_ICONS: Record<FormatCategory, typeof Braces> = {
  data: FileJson,
  web: CodeXml,
  programming: Brackets,
  api: Webhook,
  advanced: Binary,
};
