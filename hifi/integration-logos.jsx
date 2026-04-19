// Brand marks under `hifi/assets/integrations/` (see `official/` and integration-connectors.js).
const INTEGRATION_ASSET_BASE = "hifi/assets/integrations/";

const IntegrationLogo = ({ slug, size = 30, title, className = "", style }) => {
  const C = typeof window !== "undefined" ? window.ShogunIntegrationConnectors : null;
  const file = C && slug ? C.getIconFile(slug) : null;
  const dim = Math.max(16, size - 8);
  if (!file) {
    return (
      <div
        className={`s-intg-icon ${className}`.trim()}
        style={{ width: size, height: size, ...style }}
        title={title}
        aria-hidden={!title}
      >
        <Icon name="plug" size={14} className="dim" />
      </div>
    );
  }
  return (
    <div
      className={`s-intg-icon s-intg-icon-brand ${className}`.trim()}
      style={{ width: size, height: size, ...style }}
      title={title}
      role="img"
      aria-label={title || slug}
    >
      <img
        src={INTEGRATION_ASSET_BASE + file}
        width={dim}
        height={dim}
        alt=""
        draggable={false}
        decoding="async"
      />
    </div>
  );
};

window.IntegrationLogo = IntegrationLogo;
