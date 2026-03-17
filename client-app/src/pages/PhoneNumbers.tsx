import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Plus, Trash2, Phone, X } from 'lucide-react';
import TooltipWalkthrough from '../components/TooltipWalkthrough';
import { useRole } from '../lib/useRole';

interface PhoneNumber {
  id: string;
  phone_number: string;
  friendly_name: string;
  twilio_sid: string;
  routed_agent_id: string | null;
  routing_active: boolean;
  capabilities: Record<string, unknown>;
  created_at: string;
}

interface Agent {
  id: string;
  name: string;
}

function AddPhoneModal({ agents, onClose }: { agents: Agent[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ phone_number: '', friendly_name: '', twilio_sid: '', agent_id: '' });

  const mutation = useMutation({
    mutationFn: (data: typeof form) => api.post('/phone-numbers', { ...data, agent_id: data.agent_id || null }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['phone-numbers'] }); onClose(); },
  });

  const set = (key: string, val: string) => setForm((f) => ({ ...f, [key]: val }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="bg-surface border border-border rounded-xl shadow-lg w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">Add Phone Number</h2>
          <button onClick={onClose}><X className="h-5 w-5 text-text-secondary" /></button>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); mutation.mutate(form); }} className="p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Phone Number (E.164)</label>
            <input value={form.phone_number} onChange={(e) => set('phone_number', e.target.value)} required placeholder="+15551234567"
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Friendly Name</label>
            <input value={form.friendly_name} onChange={(e) => set('friendly_name', e.target.value)} placeholder="Main Line"
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Twilio SID</label>
            <input value={form.twilio_sid} onChange={(e) => set('twilio_sid', e.target.value)} placeholder="PNxxx..."
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Assign Agent</label>
            <select value={form.agent_id} onChange={(e) => set('agent_id', e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm">
              <option value="">None</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          {mutation.error && <p className="text-danger text-sm">{(mutation.error as Error).message}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-text-secondary rounded-lg border border-border hover:bg-surface-hover transition">Cancel</button>
            <button type="submit" disabled={mutation.isPending}
              className="px-4 py-2 text-sm font-medium bg-primary text-white rounded-lg hover:bg-primary-hover transition disabled:opacity-50">
              {mutation.isPending ? 'Adding...' : 'Add'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ReassignModal({ phone, agents, onClose }: { phone: PhoneNumber; agents: Agent[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [agentId, setAgentId] = useState(phone.routed_agent_id ?? '');

  const mutation = useMutation({
    mutationFn: (newAgentId: string) => api.patch(`/phone-numbers/${phone.id}/routing`, { agent_id: newAgentId || null }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['phone-numbers'] }); onClose(); },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="bg-surface border border-border rounded-xl shadow-lg w-full max-w-sm">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">Reassign Agent</h2>
          <button onClick={onClose}><X className="h-5 w-5 text-text-secondary" /></button>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); mutation.mutate(agentId); }} className="p-5 space-y-4">
          <p className="text-sm text-text-secondary">
            Change agent for <span className="font-medium text-text-primary">{phone.friendly_name || phone.phone_number}</span>
          </p>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Agent</label>
            <select value={agentId} onChange={(e) => setAgentId(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm">
              <option value="">None</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          {mutation.error && <p className="text-danger text-sm">{(mutation.error as Error).message}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-text-secondary rounded-lg border border-border hover:bg-surface-hover transition">Cancel</button>
            <button type="submit" disabled={mutation.isPending}
              className="px-4 py-2 text-sm font-medium bg-primary text-white rounded-lg hover:bg-primary-hover transition disabled:opacity-50">
              {mutation.isPending ? 'Saving...' : 'Reassign'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function PhoneNumbers() {
  const [showAdd, setShowAdd] = useState(false);
  const [reassigning, setReassigning] = useState<PhoneNumber | null>(null);
  const queryClient = useQueryClient();
  const { isManager } = useRole();

  const { data, isLoading } = useQuery({
    queryKey: ['phone-numbers'],
    queryFn: () => api.get<{ phoneNumbers: PhoneNumber[]; total: number }>('/phone-numbers?limit=100'),
  });

  const { data: agentsData } = useQuery({
    queryKey: ['agents', 'list'],
    queryFn: () => api.get<{ agents: Agent[] }>('/agents?limit=100'),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/phone-numbers/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['phone-numbers'] }),
  });

  const numbers = data?.phoneNumbers ?? [];
  const agents = agentsData?.agents ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Phone Numbers</h1>
          <p className="text-sm text-text-secondary mt-1">Manage Twilio phone numbers and agent routing</p>
        </div>
        {isManager && (
          <TooltipWalkthrough
            tooltipKey="phone-setup"
            title="Connect a Phone Number"
            description="Add a Twilio phone number and route it to your agent. Inbound calls to this number will be answered by your AI agent automatically."
            position="left"
          >
            <button onClick={() => setShowAdd(true)}
              className="inline-flex items-center gap-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium px-4 py-2.5 rounded-lg transition">
              <Plus className="h-4 w-4" /> Add Number
            </button>
          </TooltipWalkthrough>
        )}
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-text-secondary">Loading...</div>
      ) : numbers.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 text-center">
          <Phone className="h-12 w-12 text-text-muted mx-auto mb-3" />
          <p className="text-text-secondary">No phone numbers configured</p>
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="px-5 py-3 text-text-secondary font-medium">Number</th>
                <th className="px-5 py-3 text-text-secondary font-medium">Name</th>
                <th className="px-5 py-3 text-text-secondary font-medium">Agent</th>
                <th className="px-5 py-3 text-text-secondary font-medium w-32">Actions</th>
              </tr>
            </thead>
            <tbody>
              {numbers.map((pn) => (
                <tr key={pn.id} className="border-b border-border last:border-0 hover:bg-surface-hover transition-colors">
                  <td className="px-5 py-3 font-mono text-xs">{pn.phone_number}</td>
                  <td className="px-5 py-3 text-text-primary">{pn.friendly_name || '--'}</td>
                  <td className="px-5 py-3 text-text-secondary">{agents.find((a) => a.id === pn.routed_agent_id)?.name || '--'}</td>
                  <td className="px-5 py-3 space-x-3">
                    {isManager ? (
                      <>
                        <button onClick={() => setReassigning(pn)}
                          className="text-primary hover:text-primary-hover text-xs font-medium transition">Reassign</button>
                        <button onClick={() => { if (confirm('Remove this number?')) deleteMut.mutate(pn.id); }}
                          className="text-text-secondary hover:text-danger transition"><Trash2 className="h-4 w-4 inline" /></button>
                      </>
                    ) : (
                      <span className="text-xs text-text-muted">View only</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showAdd && <AddPhoneModal agents={agents} onClose={() => setShowAdd(false)} />}
      {reassigning && <ReassignModal phone={reassigning} agents={agents} onClose={() => setReassigning(null)} />}
    </div>
  );
}
