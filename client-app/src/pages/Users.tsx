import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Plus, Users as UsersIcon, X, ShieldCheck, ShieldAlert } from 'lucide-react';
import { useRole, ROLE_LABELS, type SimpleRole } from '../lib/useRole';

interface User {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  role: string;
  created_at: string;
}

const ROLES: SimpleRole[] = ['owner', 'manager', 'operator', 'viewer'];

function InviteModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ email: '', first_name: '', last_name: '', password: '', role: 'viewer' });

  const mutation = useMutation({
    mutationFn: (data: typeof form) => api.post('/users/invite', data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['users'] }); onClose(); },
  });

  const set = (key: string, val: string) => setForm((f) => ({ ...f, [key]: val }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="bg-surface border border-border rounded-xl shadow-lg w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">Invite User</h2>
          <button onClick={onClose}><X className="h-5 w-5 text-text-secondary" /></button>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); mutation.mutate(form); }} className="p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Email</label>
            <input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} required
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">First Name</label>
              <input value={form.first_name} onChange={(e) => set('first_name', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Last Name</label>
              <input value={form.last_name} onChange={(e) => set('last_name', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Password (optional)</label>
            <input type="password" value={form.password} onChange={(e) => set('password', e.target.value)} minLength={8} placeholder="Leave blank for email invite"
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Role</label>
            <select value={form.role} onChange={(e) => set('role', e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm">
              {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </select>
            <p className="text-xs text-text-muted mt-1">The role determines what the user can access</p>
          </div>
          {mutation.error && <p className="text-danger text-sm">{(mutation.error as Error).message}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-text-secondary rounded-lg border border-border hover:bg-surface-hover transition">Cancel</button>
            <button type="submit" disabled={mutation.isPending}
              className="px-4 py-2 text-sm font-medium bg-primary text-white rounded-lg hover:bg-primary-hover transition disabled:opacity-50">
              {mutation.isPending ? 'Inviting...' : 'Invite'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const ROLE_BADGE_STYLES: Record<SimpleRole, string> = {
  owner: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
  manager: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
  operator: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
  viewer: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400',
};

export default function UsersPage() {
  const [showInvite, setShowInvite] = useState(false);
  const queryClient = useQueryClient();
  const { isOwner } = useRole();

  const { data, isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<{ users: User[]; total: number }>('/users?limit=100'),
  });

  const roleMut = useMutation({
    mutationFn: ({ id, role }: { id: string; role: string }) => api.patch(`/users/${id}/role`, { role }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  });

  const users = data?.users ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Users</h1>
          <p className="text-sm text-text-secondary mt-1">Manage team members and permissions</p>
        </div>
        {isOwner && (
          <button onClick={() => setShowInvite(true)}
            className="inline-flex items-center gap-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium px-4 py-2.5 rounded-lg transition">
            <Plus className="h-4 w-4" /> Invite User
          </button>
        )}
      </div>

      {!isOwner && (
        <div className="bg-surface-hover border border-border rounded-lg px-4 py-3 flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-text-muted shrink-0" />
          <p className="text-sm text-text-muted">Only Owners can invite users and change roles.</p>
        </div>
      )}

      {isLoading ? (
        <div className="text-center py-12 text-text-secondary">Loading...</div>
      ) : users.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 text-center">
          <UsersIcon className="h-12 w-12 text-text-muted mx-auto mb-3" />
          <p className="text-text-secondary">No users found</p>
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="px-5 py-3 text-text-secondary font-medium">Email</th>
                <th className="px-5 py-3 text-text-secondary font-medium">Name</th>
                <th className="px-5 py-3 text-text-secondary font-medium">Role</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className="border-b border-border last:border-0 hover:bg-surface-hover transition-colors">
                  <td className="px-5 py-3 text-text-primary">{user.email}</td>
                  <td className="px-5 py-3 text-text-secondary">{[user.first_name, user.last_name].filter(Boolean).join(' ') || '--'}</td>
                  <td className="px-5 py-3">
                    {isOwner ? (
                      <select
                        value={user.role}
                        onChange={(e) => roleMut.mutate({ id: user.id, role: e.target.value })}
                        className="px-2 py-1 rounded border border-border bg-surface text-text-primary text-xs"
                      >
                        {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                      </select>
                    ) : (
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${ROLE_BADGE_STYLES[user.role as SimpleRole] ?? ROLE_BADGE_STYLES.viewer}`}>
                        <ShieldCheck className="h-3 w-3" />
                        {ROLE_LABELS[user.role as SimpleRole] ?? user.role}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showInvite && <InviteModal onClose={() => setShowInvite(false)} />}
    </div>
  );
}
