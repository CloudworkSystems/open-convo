import { NEXUS_PRIMITIVES, NEXUS_PRIMITIVE_AVAILABILITY } from '../content/nexus-primitives';
import { roadmapEvidenceLink } from '../domain/recovery-roadmap';
import { Modal } from '../ui/Modal';
import './nexus-primitives.css';

export function NexusPrimitives({
  onClose,
  onOpenRoadmap,
}: {
  onClose: () => void;
  onOpenRoadmap: () => void;
}) {
  return (
    <div className="nexus-primitives-modal">
      <Modal title="NEXUS work primitives" onClose={onClose}>
        <div className="nexus-primitives-content">
          <p className="nexus-primitives-intro">
            These eight recovered work types belong in an ordinary conversation. You do not need
            to type a command prefix. Their worker connections are still planned.
          </p>
          <ul className="nexus-primitives-list" aria-label="Eight planned work types">
            {NEXUS_PRIMITIVES.map((primitive) => (
              <li key={primitive.name}>
                <h3>{primitive.name}</h3>
                <p>{primitive.purpose}</p>
                <span className="nexus-primitives-availability">{NEXUS_PRIMITIVE_AVAILABILITY}</span>
              </li>
            ))}
          </ul>
          <section className="nexus-primitives-routing" aria-labelledby="nexus-classify-title">
            <h3 id="nexus-classify-title">Classify connects the steps</h3>
            <p>
              Classify is the planned routing check before, between and after work. It helps decide
              which type fits and who acts next; it is not a ninth primitive or an active classifier.
            </p>
          </section>
          <section className="nexus-primitives-pilot" aria-labelledby="nexus-plan-pilot-title">
            <span className="eyebrow">FIRST REAL PILOT</span>
            <h3 id="nexus-plan-pilot-title">One Plan, saved and returned</h3>
            <p>
              Start from one request, use one approved worker, and return a saved Plan to its
              source conversation with the goal, steps and finish line. Review it and stop there.
              Build follows as a separate, bounded decision.
            </p>
            <p>
              The preview currently creates simulated replies and planning records. The pilot still
              needs the saving, provider, permission and review checks recorded in ROADMAP.
            </p>
            <a href={roadmapEvidenceLink('PLAN.md')!} target="_blank" rel="noreferrer">
              Read the Open Convo build plan
            </a>
          </section>
          <div className="nexus-primitives-actions">
            <button type="button" className="secondary-button" onClick={onOpenRoadmap}>
              Open ROADMAP
            </button>
            <button type="button" className="text-button" onClick={onClose}>Close</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
