import { AlertTriangle, CheckCircle2, ClipboardCheck, ExternalLink, PhoneForwarded } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { HealthcareOutcomeDashboardProjection } from '../../../shared/receptionist/healthcareOutcomeDashboard';

function label(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function EvidenceRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium text-text-muted">{term}</dt>
      <dd className="mt-0.5 text-sm text-text-primary">{children}</dd>
    </div>
  );
}

export default function HealthcareOutcomeCard({
  projection,
  compact = false,
  showTicketLink = true,
}: {
  projection: HealthcareOutcomeDashboardProjection;
  compact?: boolean;
  showTicketLink?: boolean;
}) {
  const needsAttention = projection.delivery?.status === 'dead_letter'
    || projection.delivery?.status === 'failed'
    || projection.delivery?.status === 'retry'
    || projection.tool?.status === 'failed';
  const OutcomeIcon = needsAttention ? AlertTriangle : projection.followUp?.ticketId ? CheckCircle2 : PhoneForwarded;

  return (
    <section className="rounded-xl border border-border bg-surface p-4" data-testid="healthcare-outcome-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <span className={`mt-0.5 rounded-lg p-1.5 ${needsAttention ? 'bg-danger-light text-danger' : 'bg-primary-light text-primary'}`}>
            <OutcomeIcon className="h-4 w-4" aria-hidden="true" />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-heading">Receptionist outcome</h3>
            <p className="text-xs text-text-muted">{projection.operationalValue.evidence}</p>
          </div>
        </div>
        {projection.outcome && (
          <span className="rounded-full bg-primary-light px-2.5 py-1 text-xs font-medium text-primary">
            {label(projection.outcome.type)}
          </span>
        )}
      </div>

      {projection.outcome && (
        <div className="mt-3 rounded-lg bg-surface-hover p-3">
          <p className="text-sm text-text-primary">{projection.outcome.summary}</p>
        </div>
      )}

      <dl className={`mt-4 grid gap-3 ${compact ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3'}`}>
        {projection.caller && (
          <EvidenceRow term="Caller">
            {[projection.caller.firstName, projection.caller.lastName].filter(Boolean).join(' ') || 'Unknown'}
            {projection.caller.phone ? ` · ${projection.caller.phone}` : ''}
          </EvidenceRow>
        )}
        {projection.intent && <EvidenceRow term="Intent">{projection.intent}</EvidenceRow>}
        {projection.outcome && <EvidenceRow term="Requested action">{projection.outcome.requestedAction}</EvidenceRow>}
        {projection.outcome && <EvidenceRow term="Urgency">{label(projection.outcome.urgency)}</EvidenceRow>}
        {projection.outcome && <EvidenceRow term="Callback preference">{projection.outcome.callbackPreference}</EvidenceRow>}
        <EvidenceRow term="Language">{projection.language || 'Unknown'}</EvidenceRow>
        <EvidenceRow term="Transcript">{projection.transcript.available ? `${projection.transcript.lineCount} lines available` : 'Not available'}</EvidenceRow>
        <EvidenceRow term="Recording">{label(projection.recording.status)}</EvidenceRow>
        {projection.followUp && <EvidenceRow term="Owner">{projection.followUp.ownerLabel}</EvidenceRow>}
        {projection.followUp && <EvidenceRow term="Follow-up status">{label(projection.followUp.status)}</EvidenceRow>}
        {projection.followUp && <EvidenceRow term="Next action">{projection.followUp.nextAction}</EvidenceRow>}
      </dl>

      {(projection.delivery || projection.tool || projection.escalation) && (
        <div className="mt-4 space-y-2 border-t border-border pt-3 text-xs">
          {projection.delivery && (
            <div className="flex flex-wrap items-center gap-2 text-text-secondary">
              <ClipboardCheck className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Durable delivery: <strong className="text-text-primary">{label(projection.delivery.status)}</strong></span>
              {projection.delivery.error && <span className="text-danger">{projection.delivery.error}</span>}
            </div>
          )}
          {projection.tool && (
            <div className="flex flex-wrap items-center gap-2 text-text-secondary">
              <ClipboardCheck className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Tool {projection.tool.name}: <strong className="text-text-primary">{label(projection.tool.status)}</strong></span>
              {projection.tool.error && <span className="text-danger">{projection.tool.error}</span>}
            </div>
          )}
          {projection.escalation && (
            <div className="flex flex-wrap items-center gap-2 text-danger">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Human escalation: {projection.escalation.reason} · {label(projection.escalation.status)} · {projection.escalation.ownerLabel}</span>
            </div>
          )}
        </div>
      )}

      {showTicketLink && projection.followUp?.ticketId && (
        <div className="mt-4 border-t border-border pt-3">
          <Link
            to={`/tickets/${projection.followUp.ticketId}`}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
          >
            Open follow-up ticket <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </div>
      )}
    </section>
  );
}
