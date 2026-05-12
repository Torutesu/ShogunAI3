import { Row } from '../../components/Row';

interface CostSectionProps {
  extractionModel: string;
  setExtractionModel: (v: string) => void;
  monthlyCap: string;
  setMonthlyCap: (v: string) => void;
  capAction: string;
  setCapAction: (v: string) => void;
  fallbackModel: string;
  setFallbackModel: (v: string) => void;
  persistCost: (patch: any) => void;
  persistLLMModel: (val: string) => void;
}

export function CostSection({
  extractionModel,
  setExtractionModel,
  monthlyCap,
  setMonthlyCap,
  capAction,
  setCapAction,
  fallbackModel,
  setFallbackModel,
  persistCost,
  persistLLMModel,
}: CostSectionProps) {
  return (
    <div className="s-card" style={{ padding: 20, marginBottom: 16 }}>
      <h3 style={{ marginTop: 0 }}>BYOK extraction cost</h3>
      <Row title="Extraction model" desc="Anthropic ID used by AnthropicExtractionClient. Sonnet / Opus increase quality + cost (3x / 15x).">
        <select
          className="s-select"
          value={extractionModel}
          onChange={(e) => { const v = e.target.value; setExtractionModel(v); persistLLMModel(v); }}
        >
          <option value="claude-haiku-4-5">claude-haiku-4-5 (default, ~$9/mo median)</option>
          <option value="claude-sonnet-4-6">claude-sonnet-4-6 (3x cost)</option>
          <option value="claude-opus-4-7">claude-opus-4-7 (15x cost)</option>
        </select>
      </Row>
      <Row title="Monthly cap (USD)" desc="When this month's cost_ledger total reaches the cap, cap_action below decides what happens.">
        <input
          className="s-input"
          type="number"
          step="1"
          min="0"
          value={monthlyCap}
          onChange={(e) => setMonthlyCap(e.target.value)}
          onBlur={() => persistCost({ monthly_cap_usd: Number(monthlyCap) || 10 })}
          style={{ width: 90 }}
        />
      </Row>
      <Row title="Cap action" desc="pause_extraction = capture continues, jobs sit until next month. pause_capture = capture also stops. fallback_to_lighter = swap to fallback model.">
        <select
          className="s-select"
          value={capAction}
          onChange={(e) => { const v = e.target.value; setCapAction(v); persistCost({ cap_action: v }); }}
        >
          <option value="pause_extraction">pause_extraction (recommended)</option>
          <option value="pause_capture">pause_capture (hard cap)</option>
          <option value="fallback_to_lighter">fallback_to_lighter</option>
        </select>
      </Row>
      <Row title="Fallback model" desc="Used when cap_action = fallback_to_lighter and the cap is reached." last>
        <select
          className="s-select"
          value={fallbackModel}
          onChange={(e) => { const v = e.target.value; setFallbackModel(v); persistCost({ fallback_model: v }); }}
        >
          <option value="claude-haiku-4-5">claude-haiku-4-5</option>
          <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
        </select>
      </Row>
    </div>
  );
}
