import { useId, type InputHTMLAttributes, type ReactNode } from 'react';

/** Touch-friendly form building blocks: every control is at least 44 px tall (OFFLINE_DESIGN §5). */

export const inputClass =
  'block min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-base text-slate-900 focus:border-sky-700 focus:outline-none focus:ring-2 focus:ring-sky-700/30 disabled:bg-slate-100 disabled:text-slate-500';

const buttonBase =
  'inline-flex min-h-11 items-center justify-center rounded-md px-4 text-base font-medium disabled:opacity-60';

export const primaryButtonClass = `${buttonBase} bg-sky-700 text-white`;
export const secondaryButtonClass = `${buttonBase} border border-slate-300 bg-white text-slate-800`;
export const dangerButtonClass = `${buttonBase} bg-red-700 text-white`;

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  label: string;
  hint?: string;
}

export function TextField({ label, hint, ...inputProps }: TextFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-800">
        {label}
      </label>
      <input
        id={id}
        className={inputClass}
        {...(hint === undefined ? {} : { 'aria-describedby': hintId })}
        {...inputProps}
      />
      {hint === undefined ? null : (
        <p id={hintId} className="mt-1 text-sm text-slate-600">
          {hint}
        </p>
      )}
    </div>
  );
}

/** Inline error for a form. `role="alert"` so a screen reader announces it. */
export function FormError({ message }: { message: string | undefined }) {
  if (message === undefined) return null;
  return (
    <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
      {message}
    </p>
  );
}

export function InfoNote({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="rounded-md bg-sky-50 px-3 py-2 text-sm text-sky-900">
      {children}
    </p>
  );
}

export function Badge({
  tone,
  children,
}: {
  tone: 'green' | 'amber' | 'red' | 'slate';
  children: ReactNode;
}) {
  const tones = {
    green: 'bg-emerald-100 text-emerald-900',
    amber: 'bg-amber-100 text-amber-900',
    red: 'bg-red-100 text-red-900',
    slate: 'bg-slate-200 text-slate-800',
  } as const;
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}
