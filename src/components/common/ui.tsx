import { clsx } from 'clsx';
import { Check, ChevronRight, X } from 'lucide-react';
import { Dialog as RDialog, DropdownMenu, Popover as RPopover, Switch as RSwitch, Tabs as RTabs, Tooltip as RTooltip } from 'radix-ui';
import { forwardRef, type ButtonHTMLAttributes, type ComponentProps, type ReactNode } from 'react';

export const cx = clsx;

// ------------------------------------------------------------------ buttons

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
type Size = 'xs' | 'sm' | 'md';

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-contrast hover:brightness-110 shadow-[inset_0_1px_0_rgb(255_255_255/0.18),0_1px_2px_rgb(0_0_0/0.3)] font-semibold',
  secondary: 'bg-surface-3 text-text border border-border-strong hover:bg-elevated hover:border-faint',
  ghost: 'text-muted hover:text-text hover:bg-surface-3',
  subtle: 'text-text bg-surface-2 border border-border hover:bg-surface-3',
  danger: 'bg-error-soft text-error border border-error/40 hover:bg-error hover:text-white',
};
const sizes: Record<Size, string> = {
  xs: 'h-6 px-2 text-[11px] gap-1 rounded-md',
  sm: 'h-7 px-2.5 text-xs gap-1.5 rounded-md',
  md: 'h-8 px-3 text-[13px] gap-2 rounded-lg',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  kbd?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'secondary', size = 'sm', icon, kbd, className, children, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={cx(
        'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium transition-[background,color,border,filter] duration-150 disabled:pointer-events-none disabled:opacity-40',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
      {kbd && <Kbd className="ml-1 hidden xl:inline-flex">{kbd}</Kbd>}
    </button>
  );
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonProps & { label: string; tooltip?: string; active?: boolean }>(function IconButton(
  { label, tooltip, active, size = 'sm', variant = 'ghost', className, children, ...rest },
  ref,
) {
  const dim = size === 'xs' ? 'h-6 w-6' : size === 'sm' ? 'h-7 w-7' : 'h-8 w-8';
  const btn = (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-pressed={active}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-md transition-colors disabled:pointer-events-none disabled:opacity-40',
        dim,
        variants[variant],
        active && 'bg-accent-soft text-accent',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
  return <Tooltip content={tooltip ?? label}>{btn}</Tooltip>;
});

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cx('inline-flex h-[18px] items-center rounded border border-border-strong bg-surface-2 px-1 font-mono text-[10px] font-medium text-muted', className)}>{children}</kbd>;
}

export function Badge({ children, tone = 'neutral', className, title }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'error' | 'info'; className?: string; title?: string }) {
  const tones = {
    neutral: 'bg-surface-3 text-muted border-border',
    accent: 'bg-accent-soft text-accent border-accent/30',
    success: 'bg-success-soft text-success border-success/30',
    warning: 'bg-warning-soft text-warning border-warning/30',
    error: 'bg-error-soft text-error border-error/30',
    info: 'bg-info-soft text-info border-info/30',
  };
  return (
    <span title={title} className={cx('inline-flex items-center gap-1 rounded-md border px-1.5 py-px text-[10.5px] font-semibold uppercase tracking-wide', tones[tone], className)}>
      {children}
    </span>
  );
}

export function Separator({ vertical = true, className }: { vertical?: boolean; className?: string }) {
  return <div role="separator" className={cx(vertical ? 'mx-1 h-5 w-px' : 'my-1 h-px w-full', 'shrink-0 bg-border', className)} />;
}

// ------------------------------------------------------------------ tooltip

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RTooltip.Provider delayDuration={350} skipDelayDuration={150}>
      {children}
    </RTooltip.Provider>
  );
}

export function Tooltip({ content, children, side = 'bottom' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  if (!content) return <>{children}</>;
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content side={side} sideOffset={6} className="fx-fade-in z-50 max-w-xs rounded-md border border-border-strong bg-elevated px-2 py-1 text-[11.5px] text-text shadow-panel">
          {content}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}

// ------------------------------------------------------------------ menus

export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;
export const MenuGroup = DropdownMenu.Group;
export const MenuSub = DropdownMenu.Sub;

export function MenuContent({ children, className, align = 'start', ...rest }: ComponentProps<typeof DropdownMenu.Content>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        align={align}
        sideOffset={6}
        collisionPadding={8}
        className={cx('fx-fade-in z-50 min-w-[200px] overflow-y-auto rounded-lg border border-border-strong bg-elevated p-1 text-[12.5px] text-text shadow-panel', 'max-h-[var(--radix-dropdown-menu-content-available-height)]', className)}
        {...rest}
      >
        {children}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );
}

const itemCls = 'relative flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-40 data-[highlighted]:bg-surface-3 data-[highlighted]:text-text';

export function MenuItem({ children, className, icon, hint, ...rest }: ComponentProps<typeof DropdownMenu.Item> & { icon?: ReactNode; hint?: ReactNode }) {
  return (
    <DropdownMenu.Item className={cx(itemCls, className)} {...rest}>
      {icon && <span className="flex h-4 w-4 items-center justify-center text-muted">{icon}</span>}
      <span className="flex-1 truncate">{children}</span>
      {hint && <span className="ml-3 text-[11px] text-faint">{hint}</span>}
    </DropdownMenu.Item>
  );
}

export function MenuCheckItem({ children, checked, onCheckedChange, ...rest }: ComponentProps<typeof DropdownMenu.CheckboxItem>) {
  return (
    <DropdownMenu.CheckboxItem checked={checked} onCheckedChange={onCheckedChange} className={cx(itemCls, 'pl-7')} {...rest}>
      <DropdownMenu.ItemIndicator className="absolute left-2 inline-flex">
        <Check size={13} />
      </DropdownMenu.ItemIndicator>
      {children}
    </DropdownMenu.CheckboxItem>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <DropdownMenu.Label className="px-2 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wider text-faint">{children}</DropdownMenu.Label>;
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className="my-1 h-px bg-border" />;
}

export function MenuSubTrigger({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <DropdownMenu.SubTrigger className={cx(itemCls, 'data-[state=open]:bg-surface-3')}>
      {icon && <span className="flex h-4 w-4 items-center justify-center text-muted">{icon}</span>}
      <span className="flex-1">{children}</span>
      <ChevronRight size={13} className="text-faint" />
    </DropdownMenu.SubTrigger>
  );
}

export function MenuSubContent({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.SubContent sideOffset={4} collisionPadding={8} className={cx('fx-fade-in z-50 max-h-[70vh] min-w-[190px] overflow-y-auto rounded-lg border border-border-strong bg-elevated p-1 text-[12.5px] shadow-panel', className)}>
        {children}
      </DropdownMenu.SubContent>
    </DropdownMenu.Portal>
  );
}

// ------------------------------------------------------------------ popover

export const Popover = RPopover.Root;
export const PopoverTrigger = RPopover.Trigger;
export function PopoverContent({ children, className, align = 'end', ...rest }: ComponentProps<typeof RPopover.Content>) {
  return (
    <RPopover.Portal>
      <RPopover.Content align={align} sideOffset={6} collisionPadding={8} className={cx('fx-fade-in z-50 rounded-xl border border-border-strong bg-elevated p-3 text-[12.5px] shadow-panel', className)} {...rest}>
        {children}
      </RPopover.Content>
    </RPopover.Portal>
  );
}

// ------------------------------------------------------------------ dialog

export function Dialog({ open, onOpenChange, title, description, children, className, footer }: { open: boolean; onOpenChange: (o: boolean) => void; title: ReactNode; description?: ReactNode; children: ReactNode; className?: string; footer?: ReactNode }) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]" />
        <RDialog.Content
          className={cx('fx-fade-in fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] w-[min(760px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border-strong bg-surface shadow-panel', className)}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div>
              <RDialog.Title className="text-[15px] font-semibold text-text">{title}</RDialog.Title>
              {description ? <RDialog.Description className="mt-0.5 text-[12.5px] text-muted">{description}</RDialog.Description> : <RDialog.Description className="sr-only">{title}</RDialog.Description>}
            </div>
            <RDialog.Close asChild>
              <button type="button" aria-label="Close" className="rounded-md p-1 text-muted hover:bg-surface-3 hover:text-text">
                <X size={16} />
              </button>
            </RDialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

// ------------------------------------------------------------------ tabs

export const Tabs = RTabs.Root;
export function TabsList({ children, className }: { children: ReactNode; className?: string }) {
  return <RTabs.List className={cx('flex items-center gap-1', className)}>{children}</RTabs.List>;
}
export function TabsTrigger({ value, children, className }: { value: string; children: ReactNode; className?: string }) {
  return (
    <RTabs.Trigger
      value={value}
      className={cx(
        'inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted outline-none transition-colors hover:text-text data-[state=active]:bg-surface-3 data-[state=active]:text-text',
        className,
      )}
    >
      {children}
    </RTabs.Trigger>
  );
}
export const TabsContent = RTabs.Content;

// ------------------------------------------------------------------ form controls

export function Switch({ checked, onCheckedChange, label, description, id }: { checked: boolean; onCheckedChange: (v: boolean) => void; label: string; description?: ReactNode; id: string }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <label htmlFor={id} className="cursor-pointer">
        <div className="text-[12.5px] font-medium text-text">{label}</div>
        {description && <div className="mt-0.5 text-[11.5px] leading-snug text-muted">{description}</div>}
      </label>
      <RSwitch.Root
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        className="relative mt-0.5 h-[18px] w-8 shrink-0 cursor-pointer rounded-full border border-border-strong bg-surface-3 transition-colors data-[state=checked]:border-accent data-[state=checked]:bg-accent"
      >
        <RSwitch.Thumb className="block h-3.5 w-3.5 translate-x-[1px] rounded-full bg-text shadow transition-transform data-[state=checked]:translate-x-[15px] data-[state=checked]:bg-accent-contrast" />
      </RSwitch.Root>
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, size = 'sm', label }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; title?: string }[]; size?: 'xs' | 'sm'; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-border bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cx(
            'rounded-md px-2 font-medium transition-colors',
            size === 'xs' ? 'h-5 text-[11px]' : 'h-6 text-xs',
            value === o.value ? 'bg-surface-3 text-text shadow-[0_0_0_1px_var(--border-strong)]' : 'text-muted hover:text-text',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Select<T extends string>({ value, onChange, options, label, className }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; label: string; className?: string }) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className={cx('h-7 rounded-md border border-border-strong bg-surface-2 px-2 text-xs text-text outline-none focus:border-accent', className)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div>
        <div className="text-[12px] font-medium text-text">{label}</div>
        {hint && <div className="text-[11px] text-faint">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

export function SupportDot({ level }: { level: 'full' | 'partial' | 'planned' }) {
  const cls = level === 'full' ? 'bg-success' : level === 'partial' ? 'bg-warning' : 'bg-faint';
  const label = level === 'full' ? 'Fully supported' : level === 'partial' ? 'Partially supported' : 'Planned';
  return <span title={label} aria-label={label} className={cx('inline-block h-1.5 w-1.5 shrink-0 rounded-full', cls)} />;
}
