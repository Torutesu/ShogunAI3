import { Row } from '../../components/Row';
import { Toggle } from '../../components/Toggle';

interface GraphSettingsSectionProps {
  readPath: string;
  setReadPath: (v: string) => void;
  captureFlag: boolean;
  setCaptureFlag: (v: boolean) => void;
  workerEnabled: boolean;
  setWorkerEnabled: (v: boolean) => void;
  meetingExtraction: boolean;
  setMeetingExtraction: (v: boolean) => void;
  pollSecs: string;
  setPollSecs: (v: string) => void;
  maxJobs: string;
  setMaxJobs: (v: string) => void;
  persistGraph: (patch: any) => void;
}

export function GraphSettingsSection({
  readPath,
  setReadPath,
  captureFlag,
  setCaptureFlag,
  workerEnabled,
  setWorkerEnabled,
  meetingExtraction,
  setMeetingExtraction,
  pollSecs,
  setPollSecs,
  maxJobs,
  setMaxJobs,
  persistGraph,
}: GraphSettingsSectionProps) {
  return (
    <div className="s-card" style={{ padding: 20, marginBottom: 16 }}>
      <Row title="Retrieval read path" desc="Switch context_assembly between legacy FTS+semantic and the KIOKU graph traversal (recursive CTE + decay).">
        <select
          className="s-select"
          value={readPath}
          onChange={(e) => { const v = e.target.value; setReadPath(v); persistGraph({ read_path: v }); }}
        >
          <option value="legacy">legacy</option>
          <option value="graph">graph</option>
        </select>
      </Row>
      <Row title="Capture → mem_captures" desc="When ON, capture_sampler / macos_ax route raw captures into mem_captures + extraction_jobs instead of mem_items.">
        <Toggle on={captureFlag} onClick={() => { const next = !captureFlag; setCaptureFlag(next); persistGraph({ capture_to_mem_captures: next }); }} />
      </Row>
      <Row title="Worker enabled" desc="Background thread polls extraction_jobs and calls the BYOK extraction model. Disabled = jobs queue but never run.">
        <Toggle on={workerEnabled} onClick={() => { const next = !workerEnabled; setWorkerEnabled(next); persistGraph({ worker_enabled: next }); }} />
      </Row>
      <Row title="Meeting → KIOKU extraction" desc="When a backend meeting ends, enqueue transcript text into mem_captures + extraction_jobs for fact extraction.">
        <Toggle on={meetingExtraction} onClick={() => { const next = !meetingExtraction; setMeetingExtraction(next); persistGraph({ meeting_extraction_enabled: next }); }} />
      </Row>
      <Row title="Worker poll interval (sec)" desc="Clamped 5–600 server-side. Lower values check the queue more often at the cost of CPU wake-ups.">
        <input
          className="s-input"
          type="number"
          min="5"
          max="600"
          value={pollSecs}
          onChange={(e) => setPollSecs(e.target.value)}
          onBlur={() => persistGraph({ poll_interval_secs: Number(pollSecs) || 30 })}
          style={{ width: 90 }}
        />
      </Row>
      <Row title="Max jobs per tick" desc="Bounds tick latency. Clamped 1–50 server-side." last>
        <input
          className="s-input"
          type="number"
          min="1"
          max="50"
          value={maxJobs}
          onChange={(e) => setMaxJobs(e.target.value)}
          onBlur={() => persistGraph({ max_jobs_per_tick: Number(maxJobs) || 5 })}
          style={{ width: 90 }}
        />
      </Row>
    </div>
  );
}
