export interface PortableVerificationRootOptions {
  localApprovedRoot: string;
  runnerTemp: string;
  projectRoot: string;
  githubActions: boolean;
}

export function localApprovedVerificationRoot(env?: NodeJS.ProcessEnv): string;

export function resolvePortableVerificationRoot(
  value: string,
  options: PortableVerificationRootOptions,
): string;
