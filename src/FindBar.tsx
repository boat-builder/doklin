import { useEffect, useRef } from "react";

type Props = {
  query: string;
  onQueryChange: (q: string) => void;
  count: number;
  current: number;
  caseSensitive: boolean;
  onToggleCase: () => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  // Bumped whenever ⌘F is pressed, so a second press re-focuses + selects the
  // input even when the bar is already open.
  focusToken: number;
};

export default function FindBar({
  query,
  onQueryChange,
  count,
  current,
  caseSensitive,
  onToggleCase,
  onNext,
  onPrev,
  onClose,
  focusToken,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusToken]);

  return (
    <div className="find-bar" role="search">
      <input
        ref={inputRef}
        className="find-input"
        type="text"
        placeholder="Find in note"
        value={query}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) onPrev();
            else onNext();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <span className="find-count">
        {query ? `${count === 0 ? 0 : current + 1}/${count}` : ""}
      </span>
      <button
        className={`find-btn find-btn-case ${caseSensitive ? "is-active" : ""}`}
        onClick={onToggleCase}
        title="Match case"
        aria-pressed={caseSensitive}
      >
        Aa
      </button>
      <button
        className="find-btn"
        onClick={onPrev}
        disabled={count === 0}
        title="Previous match (⇧⏎)"
        aria-label="Previous match"
      >
        <ChevronUpIcon />
      </button>
      <button
        className="find-btn"
        onClick={onNext}
        disabled={count === 0}
        title="Next match (⏎)"
        aria-label="Next match"
      >
        <ChevronDownIcon />
      </button>
      <button
        className="find-btn"
        onClick={onClose}
        title="Close (Esc)"
        aria-label="Close find"
      >
        <CloseIcon />
      </button>
    </div>
  );
}

function ChevronUpIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="18 15 12 9 6 15" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
