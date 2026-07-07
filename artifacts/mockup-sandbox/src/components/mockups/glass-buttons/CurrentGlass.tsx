import "./_group.css";

export function CurrentGlass() {
  return (
    <div className="gb-scene">
      <div className="gb-blob gb-blob-1" />
      <div className="gb-blob gb-blob-2" />
      <div className="gb-blob gb-blob-3" />
      <div className="gb-stack">
        <span className="gb-label">Current — Translucent Glass</span>
        <button className="gb-btn gb-current">Start Creating Free</button>
        <button className="gb-btn gb-btn-sm gb-current">Get Started</button>
        <button className="gb-btn gb-btn-sm gb-current">Generate Caption</button>
      </div>
    </div>
  );
}
