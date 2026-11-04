import { useEffect, useId, useRef, useState } from 'react';
import './guard.css';

/** An armed action stands down on its own after this long without a confirmation. */
export const DISARM_AFTER_MS = 20_000;

/**
 * An action that cannot be undone takes two deliberate steps: arm, then confirm.
 * Arming states the consequence and moves focus to the confirm button. Cancel, Escape, or
 * twenty seconds without a confirmation stands it down and returns focus to the arm button.
 */
export function GuardedAction({
  label,
  confirmLabel,
  consequence,
  cancelLabel = 'Cancel',
  pendingLabel,
  pending = false,
  disabled = false,
  confirmDisabled = false,
  danger = false,
  onArm,
  onConfirm,
  onCancel,
}: {
  readonly label: string;
  readonly confirmLabel: string;
  readonly consequence: string;
  readonly cancelLabel?: string;
  readonly pendingLabel?: string;
  readonly pending?: boolean;
  readonly disabled?: boolean;
  /** For example when the reviewed object changed after arming. */
  readonly confirmDisabled?: boolean;
  readonly danger?: boolean;
  readonly onArm?: () => void;
  readonly onConfirm: () => void;
  readonly onCancel?: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const confirm = useRef<HTMLButtonElement>(null);
  const arm = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const described = useId();
  const wasPending = useRef(pending);
  // Polling re-renders the owner every few seconds; the timer must not restart with each one.
  const cancelled = useRef(onCancel);
  useEffect(() => {
    cancelled.current = onCancel;
  });

  useEffect(() => {
    if (armed) confirm.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      arm.current?.focus();
    }
  }, [armed]);
  useEffect(() => {
    if (!armed || pending) return;
    const timer = window.setTimeout(() => {
      returnFocus.current = document.activeElement === confirm.current;
      setArmed(false);
      cancelled.current?.();
    }, DISARM_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [armed, pending]);
  // A finished attempt, successful or not, leaves the action unarmed.
  useEffect(() => {
    if (wasPending.current && !pending) setArmed(false);
    wasPending.current = pending;
  }, [pending]);

  function standDown(): void {
    returnFocus.current = true;
    setArmed(false);
    onCancel?.();
  }

  if (!armed)
    return (
      <button
        ref={arm}
        type="button"
        className={danger ? 'secondary' : undefined}
        disabled={disabled}
        onClick={() => {
          onArm?.();
          setArmed(true);
        }}
      >
        {label}
      </button>
    );
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape stands the armed action down from either button.
    <div
      className="guard"
      data-danger={danger ? '' : undefined}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !pending) {
          event.stopPropagation();
          standDown();
        }
      }}
    >
      <p id={described} className="guard-consequence">
        {consequence}
      </p>
      <div className="actions">
        <button
          ref={confirm}
          type="button"
          className="guard-confirm"
          aria-describedby={described}
          disabled={pending || confirmDisabled}
          onClick={onConfirm}
        >
          {pending && pendingLabel !== undefined ? pendingLabel : confirmLabel}
        </button>
        <button type="button" className="secondary" disabled={pending} onClick={standDown}>
          {cancelLabel}
        </button>
      </div>
    </div>
  );
}
