import { Row } from '../../components/Row';

interface SliThresholdsSectionProps {
  sliBadSuccessLt: string;
  setSliBadSuccessLt: (v: string) => void;
  sliBadP95Gt: string;
  setSliBadP95Gt: (v: string) => void;
  sliBadBacklogGt: string;
  setSliBadBacklogGt: (v: string) => void;
  sliWarnSuccessLt: string;
  setSliWarnSuccessLt: (v: string) => void;
  sliWarnP95Gt: string;
  setSliWarnP95Gt: (v: string) => void;
  sliWarnBacklogGt: string;
  setSliWarnBacklogGt: (v: string) => void;
  persistObservability: (patch: any) => void;
}

export function SliThresholdsSection({
  sliBadSuccessLt,
  setSliBadSuccessLt,
  sliBadP95Gt,
  setSliBadP95Gt,
  sliBadBacklogGt,
  setSliBadBacklogGt,
  sliWarnSuccessLt,
  setSliWarnSuccessLt,
  sliWarnP95Gt,
  setSliWarnP95Gt,
  sliWarnBacklogGt,
  setSliWarnBacklogGt,
  persistObservability,
}: SliThresholdsSectionProps) {
  return (
    <div className="s-card" style={{ padding: 20, marginBottom: 16 }}>
      <h3 style={{ marginTop: 0 }}>SLI severity thresholds</h3>
      <div className="s-field-hint" style={{ marginBottom: 12 }}>
        Home の SLI バッジ色（good / warn / bad）と Memory Debug の SLI 警戒色に使います。
      </div>
      <Row title="Bad: success < (%)" desc="この値を下回る成功率は bad 扱い。">
        <input className="s-input" type="number" min="1" max="100" value={sliBadSuccessLt} onChange={(e) => setSliBadSuccessLt(e.target.value)} onBlur={() => persistObservability({})} style={{ width: 90 }} />
      </Row>
      <Row title="Bad: p95 > (ms)" desc="この値を上回る p95 は bad 扱い。">
        <input className="s-input" type="number" min="1" value={sliBadP95Gt} onChange={(e) => setSliBadP95Gt(e.target.value)} onBlur={() => persistObservability({})} style={{ width: 110 }} />
      </Row>
      <Row title="Bad: backlog >" desc="この値を上回る backlog は bad 扱い。">
        <input className="s-input" type="number" min="0" value={sliBadBacklogGt} onChange={(e) => setSliBadBacklogGt(e.target.value)} onBlur={() => persistObservability({})} style={{ width: 90 }} />
      </Row>
      <Row title="Warn: success < (%)" desc="bad 条件を満たさない場合に warn 判定で使用。">
        <input className="s-input" type="number" min="1" max="100" value={sliWarnSuccessLt} onChange={(e) => setSliWarnSuccessLt(e.target.value)} onBlur={() => persistObservability({})} style={{ width: 90 }} />
      </Row>
      <Row title="Warn: p95 > (ms)" desc="bad 条件を満たさない場合に warn 判定で使用。">
        <input className="s-input" type="number" min="1" value={sliWarnP95Gt} onChange={(e) => setSliWarnP95Gt(e.target.value)} onBlur={() => persistObservability({})} style={{ width: 110 }} />
      </Row>
      <Row title="Warn: backlog >" desc="bad 条件を満たさない場合に warn 判定で使用。" last>
        <input className="s-input" type="number" min="0" value={sliWarnBacklogGt} onChange={(e) => setSliWarnBacklogGt(e.target.value)} onBlur={() => persistObservability({})} style={{ width: 90 }} />
      </Row>
    </div>
  );
}
