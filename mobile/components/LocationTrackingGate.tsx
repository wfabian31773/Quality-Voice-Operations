// App-level orchestration for live technician location sharing.
// Lives under AuthGate so tracking persists across screen navigation.
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { api, type DispatchJob } from '@/lib/api';
import {
  startTracking,
  statusRequiresTracking,
  stopTracking,
} from '@/lib/locationTracking';

const POLL_INTERVAL_MS = 30_000;

function pickActiveJob(jobs: DispatchJob[]): DispatchJob | null {
  for (const j of jobs) {
    if (statusRequiresTracking(j.status)) return j;
  }
  return null;
}

export function LocationTrackingGate() {
  const { client, resourceId, signedIn, deviceSecret } = useAuth();

  const query = useQuery({
    queryKey: ['active-jobs-for-tracking', resourceId],
    enabled: Boolean(signedIn && client && resourceId),
    queryFn: async () => {
      if (!client || !resourceId) return { jobs: [] as DispatchJob[] };
      const res = await api.listJobs(client, {
        resourceId,
        limit: 200,
      });
      return res;
    },
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: true,
    staleTime: 10_000,
  });

  const activeJob = query.data ? pickActiveJob(query.data.jobs) : null;

  useEffect(() => {
    if (!client || !resourceId || !deviceSecret) {
      void stopTracking();
      return;
    }
    if (activeJob) {
      void startTracking({
        client,
        resourceId,
        jobId: activeJob.id,
        deviceSecret,
      });
    } else {
      void stopTracking();
    }
  }, [client, resourceId, deviceSecret, activeJob?.id, activeJob?.status]);

  useEffect(() => {
    return () => {
      void stopTracking();
    };
  }, []);

  return null;
}
