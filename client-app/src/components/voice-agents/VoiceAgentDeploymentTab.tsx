import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Phone } from 'lucide-react';
import { api } from '../../lib/api';
import {
  formatAssignedNumbers,
  isValidPostCallEmail,
  phonesAvailableToAssign,
  phonesRoutedToAgent,
  type StudioPhoneNumber,
} from '../../lib/voiceAgentStudioMetrics';

export default function VoiceAgentDeploymentTab({
  agentId,
  phones,
  canEdit,
  isStaff,
  postCallNotify,
  postCallEmail,
  onPostCallNotify,
  onPostCallEmail,
  onSave,
  saving,
}: {
  agentId: string;
  phones: StudioPhoneNumber[];
  canEdit: boolean;
  isStaff: boolean;
  postCallNotify: boolean;
  postCallEmail: string;
  onPostCallNotify: (value: boolean) => void;
  onPostCallEmail: (value: string) => void;
  onSave: () => void;
  saving: boolean;
}) {
  const queryClient = useQueryClient();
  const assigned = phonesRoutedToAgent(phones, agentId);
  const available = phonesAvailableToAssign(phones);
  const elsewhere = phones.filter((phone) => phone.routed_agent_id && phone.routed_agent_id !== agentId);
  const emailValid = isValidPostCallEmail(postCallEmail);

  const routing = useMutation({
    mutationFn: async ({ phoneId, nextAgentId }: { phoneId: string; nextAgentId: string | null }) => {
      await api.patch(`/phone-numbers/${phoneId}/routing`, { agent_id: nextAgentId });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['phone-numbers'] });
    },
  });

  return (
    <div className="space-y-8">
      <section>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-text-primary">Phone numbers</h3>
          <Link to="/phone-numbers" className="text-sm font-medium text-primary hover:underline">
            Add number
          </Link>
        </div>
        <p className="mb-4 text-sm text-text-muted">
          Route a tenant number to this agent. The Master Voice Agent runtime answers on that number.
        </p>

        {assigned.length > 0 ? (
          <ul className="space-y-2">
            {assigned.map((phone) => (
              <li
                key={phone.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-success/40 bg-success-light px-4 py-3"
              >
                <div>
                  <p className="text-sm font-medium text-text-primary">
                    {phone.friendly_name || phone.phone_number}
                  </p>
                  {phone.friendly_name ? (
                    <p className="font-mono text-xs text-text-muted">{phone.phone_number}</p>
                  ) : null}
                </div>
                {canEdit ? (
                  <button
                    type="button"
                    disabled={routing.isPending}
                    onClick={() => routing.mutate({ phoneId: phone.id, nextAgentId: null })}
                    className="text-sm font-medium text-danger hover:underline disabled:opacity-50"
                  >
                    Unassign
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-border px-6 py-10 text-center">
            <Phone className="h-6 w-6 text-text-muted" />
            <p className="text-sm text-text-secondary">
              Set up a phone number. Callers reach this agent once a number is routed here.
            </p>
            {elsewhere.length > 0 ? (
              <p className="text-xs text-text-muted">
                {elsewhere.length} number{elsewhere.length === 1 ? '' : 's'} already routed to other agents.
              </p>
            ) : null}
          </div>
        )}

        {routing.isError ? (
          <p className="mt-3 text-sm text-danger">
            {routing.error instanceof Error ? routing.error.message : 'Could not update routing.'}
          </p>
        ) : null}

        {canEdit && available.length > 0 ? (
          <label className="mt-4 block">
            <span className="mb-1.5 block text-xs font-medium text-text-secondary">Assign from inventory</span>
            <select
              defaultValue=""
              disabled={routing.isPending}
              onChange={(event) => {
                if (event.target.value) {
                  routing.mutate({ phoneId: event.target.value, nextAgentId: agentId });
                  event.target.value = '';
                }
              }}
              className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-text-primary disabled:opacity-50"
            >
              <option value="" disabled>Choose a number</option>
              {available.map((phone) => (
                <option key={phone.id} value={phone.id}>
                  {formatAssignedNumbers([phone])}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-text-primary">Post-call notifications</h3>
        <p className="text-sm text-text-muted">
          Save an address on this agent. QVO does not send an email from this studio yet — this stores the preference for when summaries are enabled.
        </p>
        <div className="flex items-center justify-between gap-3 rounded-xl border border-border px-4 py-3">
          <div>
            <p className="text-sm font-medium text-text-primary">Email after a call</p>
            <p className="text-xs text-text-muted">
              {postCallNotify && postCallEmail.trim()
                ? `Stored for ${postCallEmail.trim()}`
                : 'No email is sent when a call ends.'}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={postCallNotify}
            disabled={!canEdit}
            onClick={() => onPostCallNotify(!postCallNotify)}
            className={`relative h-6 w-11 rounded-full transition ${postCallNotify ? 'bg-primary' : 'bg-border'}`}
          >
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${postCallNotify ? 'left-5' : 'left-0.5'}`} />
          </button>
        </div>
        {postCallNotify ? (
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-text-secondary">Notification email</span>
            <input
              type="email"
              value={postCallEmail}
              disabled={!canEdit}
              onChange={(event) => onPostCallEmail(event.target.value)}
              placeholder="ops@example.com"
              className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-text-primary"
            />
            {!emailValid ? (
              <p className="mt-1 text-xs text-danger">Enter a valid email, or leave this blank.</p>
            ) : null}
          </label>
        ) : null}
        {canEdit ? (
          <button
            type="button"
            onClick={onSave}
            disabled={saving || !emailValid}
            className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-on-primary disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save notification
          </button>
        ) : null}
      </section>

      {isStaff ? (
        <p className="text-sm text-text-muted">
          This studio is the default editor.{' '}
          <Link to={`/agents/${agentId}/builder`} className="text-primary hover:underline">
            Open the staff-only workflow canvas
          </Link>
          {' '}for ReactFlow debugging. Tenants should stay here.
        </p>
      ) : (
        <p className="text-sm text-text-muted">
          This studio is the default editor. The advanced workflow canvas is reserved for QVO staff.
        </p>
      )}
    </div>
  );
}
