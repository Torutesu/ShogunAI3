// Brand mark — served from public/assets/ via Vite
const KAMON_SRC = '/assets/mark.png?v=2';

interface KamonProps {
  size?: number;
  color?: string;
  className?: string;
}

/** App logo. `color` is accepted for API compatibility with existing call sites; asset is the official raster mark. */
export const Kamon = ({ size = 28, color: _color, className = '' }: KamonProps) => (
  <img
    className={`kamon-img${className ? ` ${className}` : ''}`}
    src={KAMON_SRC}
    width={size}
    height={size}
    alt="Shogun AI"
    draggable={false}
    decoding="async"
  />
);

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).Kamon = Kamon;
}
