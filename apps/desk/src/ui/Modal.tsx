import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import './modal.css';

const focusable =
  'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]';

export function Modal({
  title,
  onClose,
  children,
  drawer = false,
  scrollable = false,
  portalRoot,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  drawer?: boolean;
  scrollable?: boolean;
  portalRoot?: Element | null;
}) {
  const element = useRef<HTMLDivElement>(null);
  const closeCallback = useRef(onClose);
  closeCallback.current = onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = element.current;
    if (!dialog) return;
    const initial =
      dialog.querySelector<HTMLElement>('[data-autofocus]') ??
      dialog.querySelector<HTMLElement>(focusable);
    initial?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKey = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (dialogs[dialogs.length - 1] !== dialog) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeCallback.current();
      }
      if (event.key !== 'Tab') return;
      const elements = Array.from(dialog.querySelectorAll<HTMLElement>(focusable)).filter(
        (item) => item.getClientRects().length > 0,
      );
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!first) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first || !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.body.style.overflow = previousOverflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  // Capture the opener in the mount effect before moving focus for a page change.
  useEffect(() => {
    const dialog = element.current;
    if (!dialog) return;
    dialog.querySelector('.modal-body')?.scrollTo(0, 0);
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !dialog.contains(active) || active.getClientRects().length === 0) {
      dialog.querySelector<HTMLElement>(focusable)?.focus();
    }
  }, [title]);
  const content = (
    <div
      className={`modal-backdrop${drawer ? ' drawer-backdrop' : ''}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={element}
        className={`modal${drawer ? ' navigation-drawer' : ''}${scrollable ? ' modal-scrollable' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className="modal-heading">
          <h2>{title}</h2>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label={drawer ? 'Close navigation' : `Close ${title.toLowerCase()}`}
          >
            <Icon name="close" />
          </button>
        </div>
        {scrollable ? <div className="modal-body">{children}</div> : children}
      </div>
    </div>
  );
  // A shared editor opened from native fullscreen must be inside its visible
  // subtree. Keeping the existing Modal preserves its form and focus handling.
  return portalRoot ? createPortal(content, portalRoot) : content;
}
