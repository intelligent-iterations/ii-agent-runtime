/**
 * Who is using the runtime. The runtime itself names nothing: each consumer supplies its identity, and every durable
 * trace a run leaves (task branches, commit author, and whatever records an adapter keeps) is named from it, so a
 * consumer keeps its existing records across versions.
 */
export interface ConsumerIdentity {
  /** Lowercase name, for example `sample-app`. */
  name: string;
  /** Shown to people as the commit author and in records, for example `Sample App`. */
  displayName: string;
}

export interface ConsumerNames {
  /** Task branches are `<branchPrefix>/<task reference>-run-<run id>`. */
  branchPrefix: string;
  authorName: string;
}

export function consumerNames(identity: ConsumerIdentity): ConsumerNames {
  const { name, displayName } = identity;
  if (typeof name !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name) || name.length > 39) throw Error('Invalid consumer name');
  if (typeof displayName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,49}$/.test(displayName)) throw Error('Invalid consumer display name');
  return { branchPrefix: name, authorName: displayName };
}
