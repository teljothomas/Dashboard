import { useState } from 'react';
import { dangerButtonClass, secondaryButtonClass } from './form';
import { t } from '../../lib/i18n';

interface ConfirmActionProps {
  label: string;
  /** What will happen, shown while the user decides. */
  warning: string;
  confirmLabel: string;
  disabled?: boolean;
  onConfirm: () => void;
}

/** Two-step button for actions that cannot be taken back: first tap asks, second tap does it. */
export function ConfirmAction({
  label,
  warning,
  confirmLabel,
  disabled = false,
  onConfirm,
}: ConfirmActionProps) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button
        type="button"
        className={secondaryButtonClass}
        disabled={disabled}
        onClick={() => {
          setAsking(true);
        }}
      >
        {label}
      </button>
    );
  }
  return (
    <div
      role="alertdialog"
      aria-label={label}
      className="space-y-3 rounded-md border border-amber-300 bg-amber-50 p-3"
    >
      <p className="text-sm text-amber-950">{warning}</p>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          className={dangerButtonClass}
          onClick={() => {
            setAsking(false);
            onConfirm();
          }}
        >
          {confirmLabel}
        </button>
        <button
          type="button"
          className={secondaryButtonClass}
          onClick={() => {
            setAsking(false);
          }}
        >
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}
