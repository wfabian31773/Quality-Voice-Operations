import { QueryClient } from '@tanstack/react-query';
import { attachQueryClient, startOfflineQueueRunner } from './offlineQueue';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
    },
  },
});

attachQueryClient(queryClient);
startOfflineQueueRunner();
