interface RulesSectionProps {
  rulesText: string;
  setRulesText: (v: string) => void;
  rulesError: string;
  sections: any;
  saveRules: () => Promise<void>;
}

export function RulesSection({
  rulesText,
  setRulesText,
  rulesError,
  sections,
  saveRules,
}: RulesSectionProps) {
  return (
    <div className="s-card" style={{ padding: 20 }}>
      <h3 style={{ marginTop: 0 }}>User-defined rules (kioku_rules)</h3>
      <p style={{ color: '#aaa', fontSize: 12, marginTop: 0 }}>
        A JSON array of rule objects. Each object has <code>id</code>, optional <code>yaml</code> (frontmatter
        with <code>title:</code>), and <code>body</code>. Rules are injected at the top of every chat / brief /
        draft / pack system prompt. Saved to <code>settings.json</code>; the cache reloads on save.
      </p>
      <textarea
        className="s-input"
        value={rulesText}
        onChange={(e) => setRulesText(e.target.value)}
        rows={12}
        spellCheck={false}
        style={{ fontFamily: 'monospace', fontSize: 12, width: '100%' }}
      />
      {rulesError && <div style={{ color: '#e57373', marginTop: 8, fontSize: 12 }}>{rulesError}</div>}
      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <button className="btn btn-sm btn-primary" onClick={() => void saveRules()}>
          Save rules
        </button>
        <button
          className="btn btn-sm btn-secondary"
          onClick={() => setRulesText(JSON.stringify(Array.isArray(sections.kioku_rules) ? sections.kioku_rules : [], null, 2))}
        >
          Discard changes
        </button>
      </div>
    </div>
  );
}
