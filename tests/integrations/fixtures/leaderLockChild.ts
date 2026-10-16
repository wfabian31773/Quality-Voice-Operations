// Child "worker instance" for workerLeaderLockRealDb.test.ts. Holds the
// leader lock via LeaderElector and prints LEADER once it has it; the test
// then SIGKILLs this process to simulate a crashed leader.
import { LeaderElector } from '../../../platform/runtime/leaderLock';

const elector = new LeaderElector({
  connectionString: process.env.LEADER_TEST_URL!,
  lockKey: process.env.LEADER_TEST_KEY!,
  retryIntervalMs: 500,
  onAcquire: () => {
    process.stdout.write('LEADER\n');
  },
  onLose: () => {},
});
void elector.start();
setInterval(() => {}, 1_000);
