export function Toggle({
  on,
  onClick,
  id,
  ariaLabel,
}: {
  on: boolean;
  onClick: () => void;
  id?: string;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      id={id}
      onClick={onClick}
      className="s-toggle"
      data-on={on ? '1' : '0'}
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
    >
      <div className="s-toggle-knob" />
    </button>
  );
}
