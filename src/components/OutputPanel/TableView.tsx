import { useMemo } from 'react';
import { detectDelimiter, parseDelimited } from '../../parsers/csv/csvParser';

const MAX_ROWS = 1000;

export function TableView({ text, delimiter }: { text: string; delimiter?: string }) {
  const { header, rows, total } = useMemo(() => {
    const d = delimiter ?? detectDelimiter(text).delimiter;
    const all = parseDelimited(text, d, null).rows.map((r) => r.fields.map((f) => f.value));
    const [h = [], ...body] = all;
    return { header: h, rows: body.slice(0, MAX_ROWS), total: body.length };
  }, [text, delimiter]);
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="min-w-full border-separate border-spacing-0 font-mono text-[12px]">
          <thead className="sticky top-0 z-10">
            <tr>
              <th className="border-b border-r border-border bg-surface-3 px-2 py-1 text-right font-medium text-faint">#</th>
              {header.map((h, i) => (
                <th key={i} className="whitespace-nowrap border-b border-r border-border bg-surface-3 px-2 py-1 text-left font-semibold text-text">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="hover:bg-surface-2">
                <td className="border-b border-r border-border px-2 py-0.5 text-right text-faint">{i + 1}</td>
                {header.map((_, j) => (
                  <td key={j} className="max-w-[360px] truncate whitespace-nowrap border-b border-r border-border px-2 py-0.5 text-text" title={r[j]}>
                    {r[j] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="shrink-0 border-t border-border bg-surface-2 px-3 py-1 text-[11px] text-muted">
        {total.toLocaleString()} rows × {header.length} columns{total > MAX_ROWS && ` · showing the first ${MAX_ROWS.toLocaleString()}`}
      </div>
    </div>
  );
}
