import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import {
  Plus, Trash2, Phone, X, Search, Sparkles, ArrowRight,
  RefreshCw, CheckCircle2, Gift, DollarSign, MapPin, Bot,
} from 'lucide-react';
import TooltipWalkthrough from '../components/TooltipWalkthrough';
import { useRole } from '../lib/useRole';
import clsx from 'clsx';

interface PhoneNumber {
  id: string;
  phone_number: string;
  friendly_name: string;
  twilio_sid: string;
  routed_agent_id: string | null;
  routing_active: boolean;
  capabilities: Record<string, unknown>;
  is_free_number: boolean;
  monthly_cost_cents: number;
  provisioned_via: string;
  created_at: string;
}

interface Agent {
  id: string;
  name: string;
}

interface AvailableNumber {
  phoneNumber: string;
  friendlyName: string;
  locality: string;
  region: string;
  capabilities: Record<string, boolean>;
}

function formatPhone(e164: string): string {
  const cleaned = e164.replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+1') && cleaned.length === 12) {
    const digits = cleaned.slice(2);
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return e164;
}

type ProvisionStep = 'search' | 'confirm' | 'provisioning' | 'success' | 'assign';

function ProvisionFlow({
  agents,
  hasUsedFreeNumber,
  onClose,
}: {
  agents: Agent[];
  hasUsedFreeNumber: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<ProvisionStep>('search');
  const [areaCode, setAreaCode] = useState('');
  const [selectedNumber, setSelectedNumber] = useState<AvailableNumber | null>(null);
  const [friendlyName, setFriendlyName] = useState('');
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [provisionedNumber, setProvisionedNumber] = useState<string>('');
  const [provisionedId, setProvisionedId] = useState<string>('');
  const isFree = !hasUsedFreeNumber;

  const searchQuery = useQuery({
    queryKey: ['available-numbers', areaCode],
    queryFn: () =>
      api.get<{ available: AvailableNumber[]; monthlyCostCents: number }>(
        `/phone-numbers/available?areaCode=${areaCode}&limit=8`,
      ),
    enabled: false,
  });

  const autoSearch = useQuery({
    queryKey: ['available-numbers', 'auto'],
    queryFn: () =>
      api.get<{ available: AvailableNumber[]; monthlyCostCents: number }>(
        `/phone-numbers/available?limit=5`,
      ),
  });

  const provisionMutation = useMutation({
    mutationFn: (data: { phone_number: string; friendly_name?: string; agent_id?: string }) =>
      api.post<{
        phoneNumber: Record<string, unknown>;
        isFreeNumber: boolean;
        monthlyCostCents: number;
      }>('/phone-numbers/provision', data),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['phone-numbers'] });
      setProvisionedNumber(selectedNumber?.phoneNumber || '');
      setProvisionedId((data.phoneNumber?.id as string) || '');
      setStep('success');
    },
  });

  const routingMutation = useMutation({
    mutationFn: ({ phoneId, agentId }: { phoneId: string; agentId: string }) =>
      api.patch(`/phone-numbers/${phoneId}/routing`, { agent_id: agentId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['phone-numbers'] });
    },
  });

  const suggestedNumber = autoSearch.data?.available?.[0];
  const searchResults = searchQuery.data?.available ?? [];

  const handleProvision = () => {
    if (!selectedNumber) return;
    setStep('provisioning');
    provisionMutation.mutate({
      phone_number: selectedNumber.phoneNumber,
      friendly_name: friendlyName || undefined,
    });
  };

  const handleAssign = () => {
    if (selectedAgentId && provisionedId) {
      routingMutation.mutate(
        { phoneId: provisionedId, agentId: selectedAgentId },
        { onSuccess: () => onClose() },
      );
    } else {
      onClose();
    }
  };

  useEffect(() => {
    if (provisionMutation.isError) {
      setStep('confirm');
    }
  }, [provisionMutation.isError]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
      <div className="bg-surface border border-border rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden">
        {step === 'search' && (
          <div className="p-0">
            <div className="relative bg-gradient-to-b from-[#123047] to-[#1a3d5c] text-white px-8 pt-10 pb-8 text-center">
              <button
                onClick={onClose}
                className="absolute top-4 right-4 text-white/60 hover:text-white transition"
              >
                <X className="h-5 w-5" />
              </button>
              <div className="flex justify-center mb-4">
                <div className="relative">
                  <div className="w-20 h-20 rounded-full bg-[#2E8C83]/20 flex items-center justify-center">
                    <Phone className="h-10 w-10 text-[#2E8C83]" />
                  </div>
                  <Sparkles className="absolute -top-1 -right-1 h-5 w-5 text-yellow-400" />
                  <Sparkles className="absolute -top-2 left-0 h-3 w-3 text-yellow-300" />
                </div>
              </div>
              <h2 className="text-2xl font-bold font-display mb-2">
                Get your QVO number
              </h2>
              <p className="text-sm text-white/70">
                {isFree
                  ? 'Your first number is on us — completely free!'
                  : `Additional numbers are $${(200 / 100).toFixed(2)}/month`}
              </p>
              {isFree && (
                <div className="mt-3 inline-flex items-center gap-1.5 bg-emerald-500/20 text-emerald-300 text-xs font-semibold px-3 py-1.5 rounded-full">
                  <Gift className="h-3.5 w-3.5" />
                  First number FREE
                </div>
              )}
            </div>

            <div className="px-8 py-6 space-y-5">
              {autoSearch.isLoading ? (
                <div className="text-center py-8">
                  <RefreshCw className="h-6 w-6 text-primary animate-spin mx-auto mb-2" />
                  <p className="text-sm text-text-secondary">Finding available numbers...</p>
                </div>
              ) : suggestedNumber ? (
                <div>
                  <p className="text-xs text-text-secondary mb-2 uppercase tracking-wider font-medium">
                    Suggested number
                  </p>
                  <button
                    onClick={() => {
                      setSelectedNumber(suggestedNumber);
                      setStep('confirm');
                    }}
                    className="w-full group"
                  >
                    <div className="border-2 border-primary/30 hover:border-primary rounded-xl p-5 transition-all bg-primary/5 hover:bg-primary/10">
                      <p className="text-3xl font-bold text-primary font-mono tracking-wide text-center">
                        {formatPhone(suggestedNumber.phoneNumber)}
                      </p>
                      {suggestedNumber.locality && (
                        <p className="text-xs text-text-secondary mt-2 flex items-center justify-center gap-1">
                          <MapPin className="h-3 w-3" />
                          {suggestedNumber.locality}, {suggestedNumber.region}
                        </p>
                      )}
                    </div>
                  </button>

                  <button
                    onClick={() => {
                      setSelectedNumber(suggestedNumber);
                      setStep('confirm');
                    }}
                    className="w-full mt-3 bg-primary hover:bg-primary-hover text-white font-semibold py-3 rounded-xl transition text-sm"
                  >
                    Continue
                  </button>
                </div>
              ) : (
                <div className="text-center py-4 text-text-secondary text-sm">
                  No numbers found. Try searching by area code below.
                </div>
              )}

              <div>
                <button
                  onClick={() => setStep('search')}
                  className="w-full text-center text-sm font-medium text-text-secondary hover:text-text-primary transition"
                >
                  Pick a different number
                </button>
              </div>

              <div className="border-t border-border pt-4">
                <p className="text-xs text-text-secondary mb-2 font-medium">
                  Search by area code
                </p>
                <div className="flex gap-2">
                  <input
                    value={areaCode}
                    onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, '').slice(0, 3))}
                    placeholder="e.g. 212"
                    maxLength={3}
                    className="flex-1 px-3 py-2.5 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                  <button
                    onClick={() => searchQuery.refetch()}
                    disabled={areaCode.length !== 3 || searchQuery.isFetching}
                    className="px-4 py-2.5 bg-surface-hover hover:bg-surface-tertiary text-text-primary rounded-lg text-sm font-medium transition disabled:opacity-50 flex items-center gap-2"
                  >
                    {searchQuery.isFetching ? (
                      <RefreshCw className="h-4 w-4 animate-spin" />
                    ) : (
                      <Search className="h-4 w-4" />
                    )}
                    Search
                  </button>
                </div>
              </div>

              {searchResults.length > 0 && (
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {searchResults.map((n) => (
                    <button
                      key={n.phoneNumber}
                      onClick={() => {
                        setSelectedNumber(n);
                        setStep('confirm');
                      }}
                      className="w-full flex items-center justify-between px-4 py-3 rounded-lg border border-border hover:border-primary/50 hover:bg-primary/5 transition text-left"
                    >
                      <div>
                        <p className="text-sm font-semibold font-mono text-text-primary">
                          {formatPhone(n.phoneNumber)}
                        </p>
                        {n.locality && (
                          <p className="text-xs text-text-secondary">
                            {n.locality}, {n.region}
                          </p>
                        )}
                      </div>
                      <ArrowRight className="h-4 w-4 text-text-muted" />
                    </button>
                  ))}
                </div>
              )}

              {searchQuery.isError && (
                <p className="text-danger text-sm text-center">
                  Failed to search numbers. Please try again.
                </p>
              )}
            </div>
          </div>
        )}

        {step === 'confirm' && selectedNumber && (
          <div className="p-0">
            <div className="relative bg-gradient-to-b from-[#123047] to-[#1a3d5c] text-white px-8 pt-8 pb-6 text-center">
              <button
                onClick={() => setStep('search')}
                className="absolute top-4 left-4 text-white/60 hover:text-white transition text-sm"
              >
                &larr; Back
              </button>
              <button
                onClick={onClose}
                className="absolute top-4 right-4 text-white/60 hover:text-white transition"
              >
                <X className="h-5 w-5" />
              </button>
              <h2 className="text-xl font-bold font-display mb-1">Confirm your number</h2>
              <p className="text-sm text-white/70">
                Review and give your new line a name
              </p>
            </div>
            <div className="px-8 py-6 space-y-5">
              <div className="border-2 border-primary/30 rounded-xl p-5 bg-primary/5 text-center">
                <p className="text-3xl font-bold text-primary font-mono tracking-wide">
                  {formatPhone(selectedNumber.phoneNumber)}
                </p>
                {selectedNumber.locality && (
                  <p className="text-xs text-text-secondary mt-2 flex items-center justify-center gap-1">
                    <MapPin className="h-3 w-3" />
                    {selectedNumber.locality}, {selectedNumber.region}
                  </p>
                )}
                <div className="mt-3">
                  {isFree ? (
                    <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 text-sm font-semibold">
                      <Gift className="h-4 w-4" /> FREE
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-text-secondary text-sm">
                      <DollarSign className="h-4 w-4" /> $2.00/month
                    </span>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">
                  Give it a name (optional)
                </label>
                <input
                  value={friendlyName}
                  onChange={(e) => setFriendlyName(e.target.value)}
                  placeholder="e.g. Main Line, Support, Sales"
                  className="w-full px-3 py-2.5 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>

              {provisionMutation.isError && (
                <p className="text-danger text-sm text-center">
                  {(provisionMutation.error as Error).message ||
                    'Failed to get this number. Please try a different one.'}
                </p>
              )}

              <button
                onClick={handleProvision}
                disabled={provisionMutation.isPending}
                className="w-full bg-primary hover:bg-primary-hover text-white font-semibold py-3 rounded-xl transition text-sm disabled:opacity-50"
              >
                {isFree ? 'Get this number — Free!' : 'Get this number — $2.00/mo'}
              </button>

              <button
                onClick={() => {
                  setSelectedNumber(null);
                  setStep('search');
                }}
                className="w-full text-center text-sm text-text-secondary hover:text-text-primary transition"
              >
                Pick a different number
              </button>
            </div>
          </div>
        )}

        {step === 'provisioning' && (
          <div className="px-8 py-16 text-center">
            <RefreshCw className="h-10 w-10 text-primary animate-spin mx-auto mb-4" />
            <h2 className="text-xl font-bold text-text-primary font-display mb-2">
              Setting up your number...
            </h2>
            <p className="text-sm text-text-secondary">
              Connecting to our phone network. This takes just a moment.
            </p>
          </div>
        )}

        {step === 'success' && (
          <div className="p-0">
            <div className="relative bg-gradient-to-b from-[#123047] to-[#1a3d5c] text-white px-8 pt-10 pb-8 text-center">
              <button
                onClick={onClose}
                className="absolute top-4 right-4 text-white/60 hover:text-white transition"
              >
                <X className="h-5 w-5" />
              </button>
              <div className="flex justify-center mb-4">
                <div className="relative">
                  <div className="w-20 h-20 rounded-full bg-emerald-500/20 flex items-center justify-center">
                    <CheckCircle2 className="h-12 w-12 text-emerald-400" />
                  </div>
                  <Sparkles className="absolute -top-1 -right-1 h-5 w-5 text-yellow-400" />
                  <Sparkles className="absolute top-0 -left-2 h-3 w-3 text-yellow-300" />
                  <Sparkles className="absolute -bottom-1 right-0 h-4 w-4 text-yellow-400/70" />
                </div>
              </div>
              <h2 className="text-2xl font-bold font-display mb-2">
                Say hello to your new number!
              </h2>
              <p className="text-sm text-white/70">
                Check it out, your very own QVO number, ready and waiting for you!
              </p>
            </div>

            <div className="px-8 py-6 space-y-5">
              <div className="border-2 border-primary/30 rounded-xl p-5 bg-primary/5 text-center">
                <p className="text-3xl font-bold text-primary font-mono tracking-wide">
                  {formatPhone(provisionedNumber)}
                </p>
              </div>

              {agents.length > 0 ? (
                <>
                  <div>
                    <label className="block text-sm font-medium text-text-primary mb-1">
                      Assign an AI agent to answer calls
                    </label>
                    <select
                      value={selectedAgentId}
                      onChange={(e) => setSelectedAgentId(e.target.value)}
                      className="w-full px-3 py-2.5 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                    >
                      <option value="">Select an agent...</option>
                      {agents.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    onClick={handleAssign}
                    disabled={routingMutation.isPending}
                    className="w-full bg-primary hover:bg-primary-hover text-white font-semibold py-3 rounded-xl transition text-sm disabled:opacity-50"
                  >
                    {routingMutation.isPending
                      ? 'Assigning...'
                      : selectedAgentId
                        ? 'Assign Agent & Continue'
                        : 'Continue without assigning'}
                  </button>
                </>
              ) : (
                <button
                  onClick={onClose}
                  className="w-full bg-primary hover:bg-primary-hover text-white font-semibold py-3 rounded-xl transition text-sm"
                >
                  Continue
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ReassignModal({
  phone,
  agents,
  onClose,
}: {
  phone: PhoneNumber;
  agents: Agent[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [agentId, setAgentId] = useState(phone.routed_agent_id ?? '');

  const mutation = useMutation({
    mutationFn: (newAgentId: string) =>
      api.patch(`/phone-numbers/${phone.id}/routing`, {
        agent_id: newAgentId || null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['phone-numbers'] });
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="bg-surface border border-border rounded-xl shadow-lg w-full max-w-sm">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">Reassign Agent</h2>
          <button onClick={onClose}>
            <X className="h-5 w-5 text-text-secondary" />
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate(agentId);
          }}
          className="p-5 space-y-4"
        >
          <p className="text-sm text-text-secondary">
            Change agent for{' '}
            <span className="font-medium text-text-primary">
              {phone.friendly_name || phone.phone_number}
            </span>
          </p>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Agent</label>
            <select
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm"
            >
              <option value="">None</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          {mutation.error && (
            <p className="text-danger text-sm">{(mutation.error as Error).message}</p>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-text-secondary rounded-lg border border-border hover:bg-surface-hover transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={mutation.isPending}
              className="px-4 py-2 text-sm font-medium bg-primary text-white rounded-lg hover:bg-primary-hover transition disabled:opacity-50"
            >
              {mutation.isPending ? 'Saving...' : 'Reassign'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function PhoneNumbers() {
  const [showProvision, setShowProvision] = useState(false);
  const [reassigning, setReassigning] = useState<PhoneNumber | null>(null);
  const queryClient = useQueryClient();
  const { isManager } = useRole();

  const { data, isLoading } = useQuery({
    queryKey: ['phone-numbers'],
    queryFn: () =>
      api.get<{
        phoneNumbers: PhoneNumber[];
        total: number;
        hasUsedFreeNumber: boolean;
      }>('/phone-numbers?limit=100'),
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
  const hasUsedFreeNumber = data?.hasUsedFreeNumber ?? false;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Phone Numbers</h1>
          <p className="text-sm text-text-secondary mt-1">
            Get phone numbers for your AI agents
          </p>
        </div>
        {isManager && (
          <TooltipWalkthrough
            tooltipKey="phone-setup"
            title="Get a Phone Number"
            description="Get a phone number and connect it to your AI agent. Inbound calls will be answered by your AI agent automatically. Your first number is free!"
            position="left"
          >
            <button
              onClick={() => setShowProvision(true)}
              className="inline-flex items-center gap-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium px-4 py-2.5 rounded-lg transition"
            >
              <Plus className="h-4 w-4" /> Get Number
            </button>
          </TooltipWalkthrough>
        )}
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-text-secondary">Loading...</div>
      ) : numbers.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 text-center">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
            <Phone className="h-8 w-8 text-primary" />
          </div>
          <h3 className="text-lg font-semibold text-text-primary mb-2">No phone numbers yet</h3>
          <p className="text-text-secondary text-sm mb-4 max-w-sm mx-auto">
            Get your first phone number for free and start receiving AI-powered calls in minutes.
          </p>
          {isManager && (
            <button
              onClick={() => setShowProvision(true)}
              className="inline-flex items-center gap-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium px-5 py-2.5 rounded-lg transition"
            >
              <Gift className="h-4 w-4" /> Get your free number
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {!hasUsedFreeNumber && isManager && (
            <div className="bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/50 rounded-xl p-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Gift className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                <p className="text-sm font-medium text-emerald-800 dark:text-emerald-300">
                  Your first phone number is free!
                </p>
              </div>
              <button
                onClick={() => setShowProvision(true)}
                className="text-sm font-medium text-emerald-600 dark:text-emerald-400 hover:underline"
              >
                Claim it &rarr;
              </button>
            </div>
          )}

          <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-5 py-3 text-text-secondary font-medium">Number</th>
                  <th className="px-5 py-3 text-text-secondary font-medium">Name</th>
                  <th className="px-5 py-3 text-text-secondary font-medium">Agent</th>
                  <th className="px-5 py-3 text-text-secondary font-medium">Cost</th>
                  <th className="px-5 py-3 text-text-secondary font-medium w-32">Actions</th>
                </tr>
              </thead>
              <tbody>
                {numbers.map((pn) => (
                  <tr
                    key={pn.id}
                    className="border-b border-border last:border-0 hover:bg-surface-hover transition-colors"
                  >
                    <td className="px-5 py-3">
                      <span className="font-mono text-xs text-text-primary">
                        {pn.phone_number}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-text-primary">
                      {pn.friendly_name || '--'}
                    </td>
                    <td className="px-5 py-3">
                      {pn.routed_agent_id ? (
                        <span className="inline-flex items-center gap-1.5 text-text-primary text-xs">
                          <Bot className="h-3.5 w-3.5 text-primary" />
                          {agents.find((a) => a.id === pn.routed_agent_id)?.name || 'Unknown'}
                        </span>
                      ) : (
                        <span className="text-text-muted text-xs">Not assigned</span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      {pn.is_free_number ? (
                        <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 text-xs font-semibold">
                          <Gift className="h-3 w-3" /> Free
                        </span>
                      ) : (
                        <span className="text-text-secondary text-xs">
                          ${((pn.monthly_cost_cents || 200) / 100).toFixed(2)}/mo
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3 space-x-3">
                      {isManager ? (
                        <>
                          <button
                            onClick={() => setReassigning(pn)}
                            className="text-primary hover:text-primary-hover text-xs font-medium transition"
                          >
                            Reassign
                          </button>
                          <button
                            onClick={() => {
                              if (confirm('Remove this number? It will be released.'))
                                deleteMut.mutate(pn.id);
                            }}
                            className="text-text-secondary hover:text-danger transition"
                          >
                            <Trash2 className="h-4 w-4 inline" />
                          </button>
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
        </div>
      )}

      {showProvision && (
        <ProvisionFlow
          agents={agents}
          hasUsedFreeNumber={hasUsedFreeNumber}
          onClose={() => setShowProvision(false)}
        />
      )}
      {reassigning && (
        <ReassignModal
          phone={reassigning}
          agents={agents}
          onClose={() => setReassigning(null)}
        />
      )}
    </div>
  );
}
