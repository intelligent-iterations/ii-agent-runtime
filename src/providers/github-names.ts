import { consumerNames, type ConsumerIdentity } from '../runtime/consumer.js';

export interface GitHubConsumerNames {
  /** The workflow a consumer's GitHub issue runs come from; runs from any other workflow are refused. */
  workflowPath: string;
  /** The admission ledger, kept as deployments in the repository that receives the issues. */
  ledgerEnvironment: string;
  reserveTask: string;
  decideTask: string;
  reservationKind: string;
  decisionKind: string;
  ledgerDescription: string;
  /** Commits are authored as the consumer, at GitHub's no-reply address for its name. */
  authorEmail: string;
}

/** The names GitHub adapters derive from a consumer's identity. Changing the identity orphans existing ledgers. */
export function githubConsumerNames(identity: ConsumerIdentity): GitHubConsumerNames {
  consumerNames(identity);
  const { name, displayName } = identity;
  return {
    workflowPath: `.github/workflows/${name}.yml`,
    ledgerEnvironment: `${name}-reservations`,
    reserveTask: `${name}:reserve`,
    decideTask: `${name}:decide`,
    reservationKind: `${name}-reservation`,
    decisionKind: `${name}-decision`,
    ledgerDescription: `${displayName} launch quota reservation`,
    authorEmail: `${name}@users.noreply.github.com`,
  };
}
