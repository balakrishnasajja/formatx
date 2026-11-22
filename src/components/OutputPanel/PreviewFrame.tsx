import DOMPurify from 'dompurify';
import { ShieldCheck } from 'lucide-react';
import { useMemo } from 'react';

/**
 * Renders HTML safely: sanitized with DOMPurify, then shown in an iframe that
 * has no script permission, no same-origin access, and a CSP that blocks every
 * network request (so previews cannot leak data or load trackers).
 */
export function PreviewFrame({ html }: { html: string }) {
  const doc = useMemo(() => {
    const clean = DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true, svg: true },
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'base', 'meta', 'link', 'form'],
      FORBID_ATTR: ['srcset', 'ping'],
      WHOLE_DOCUMENT: false,
    });
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:"><style>
      :root{color-scheme:light dark}
      body{font:14px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif;margin:0;padding:20px 24px;color:#0f172a;background:#fff;max-width:900px}
      @media (prefers-color-scheme:dark){body{color:#e6ebf3;background:#0a0a0a}a{color:#5b9dff}code,pre{background:#171717!important}table td,table th{border-color:#2e2e2e!important}}
      pre{padding:12px;border-radius:8px;overflow:auto;background:#f3f6fa}code{font-family:ui-monospace,Consolas,monospace;font-size:.92em;background:#f3f6fa;padding:.1em .3em;border-radius:4px}pre code{background:none;padding:0}
      table{border-collapse:collapse}td,th{border:1px solid #dfe5ee;padding:4px 8px}img{max-width:100%}blockquote{margin:0;padding-left:12px;border-left:3px solid #a78bfa;color:#64748b}
    </style></head><body>${clean}</body></html>`;
  }, [html]);
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-surface-2 px-3 py-1 text-[11px] text-muted">
        <ShieldCheck size={12} className="text-success" /> Sanitized preview · scripts disabled · external resources blocked
      </div>
      <iframe title="HTML preview" sandbox="" srcDoc={doc} className="min-h-0 w-full flex-1 border-0 bg-white" referrerPolicy="no-referrer" />
    </div>
  );
}
