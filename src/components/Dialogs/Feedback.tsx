import { CircleCheck, CircleX, Info, TriangleAlert, X } from 'lucide-react';
import { useAppStore } from '../../hooks/useAppStore';
import { Button, cx, Dialog } from '../common/ui';

export function ConfirmDialog() {
  const confirm = useAppStore((s) => s.confirm);
  const set = useAppStore((s) => s.set);
  const close = () => set({ confirm: null });
  return (
    <Dialog
      open={!!confirm}
      onOpenChange={(o) => !o && close()}
      title={confirm?.title ?? ''}
      className="w-[min(440px,calc(100vw-32px))]"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant={confirm?.danger ? 'danger' : 'primary'}
            onClick={() => {
              confirm?.onConfirm();
              close();
            }}
          >
            {confirm?.confirmLabel}
          </Button>
        </>
      }
    >
      <p className="px-5 py-4 text-[12.5px] leading-relaxed text-muted">{confirm?.message}</p>
    </Dialog>
  );
}

const ICON = { success: CircleCheck, error: CircleX, info: Info, warning: TriangleAlert };
const TONE = { success: 'text-success', error: 'text-error', info: 'text-info', warning: 'text-warning' };

export function Toasts() {
  const toasts = useAppStore((s) => s.toasts);
  const dismiss = useAppStore((s) => s.dismissToast);
  return (
    <div aria-live="polite" className="pointer-events-none fixed bottom-9 right-4 z-[60] flex w-[min(380px,calc(100vw-32px))] flex-col gap-2">
      {toasts.map((t) => {
        const Icon = ICON[t.kind];
        return (
          <div key={t.id} role={t.kind === 'error' ? 'alert' : 'status'} className="fx-fade-in pointer-events-auto flex items-start gap-2 rounded-lg border border-border-strong bg-elevated px-3 py-2 text-[12.5px] text-text shadow-panel">
            <Icon size={15} className={cx('mt-0.5 shrink-0', TONE[t.kind])} />
            <span className="flex-1 leading-snug">{t.message}</span>
            <button type="button" aria-label="Dismiss" className="text-faint hover:text-text" onClick={() => dismiss(t.id)}>
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
