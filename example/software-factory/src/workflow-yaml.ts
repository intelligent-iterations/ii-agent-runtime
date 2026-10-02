/** Shared pieces of the generated hub workflow. */
export interface RuntimeSource {
  repository: string;
  revision: string;
  /** Required when the hub cannot read a private runtime source repository. */
  readTokenSecret?: string;
  /** Alternative to readTokenSecret: a read-only deploy key for the runtime source repository. */
  readSshKeySecret?: string;
}
export const expression = (value: string) => '${{ ' + value + ' }}';
export const pins = {
  checkout: 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
  node: 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
  artifact: 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
  tofu: 'opentofu/setup-opentofu@9d84900f3238fab8cd84ce47d658d25dd008be2f',
};

