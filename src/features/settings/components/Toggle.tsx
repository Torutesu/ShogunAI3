export function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <div onClick={onClick} className="s-toggle" data-on={on ? '1' : '0'}>
      <div className="s-toggle-knob" />
    </div>
  );
}
