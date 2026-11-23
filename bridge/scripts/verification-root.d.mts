export interface PortableVerificationRootOptions {
  localApprovedRoot: string;
  runnerTemp: string;
  projectRoot: string;
  githubActions: boolean;
}

export function localApprovedVerificationRoot(env?: NodeJS.ProcessEnv): string;

export function assertEmbeddedVerificationPaths(
  root: string,
  extensionId: string,
  options: { portable: boolean; platform?: string },
): void;

export function resolvePortableVerificationRoot(
  value: string,
  options: PortableVerificationRootOptions,
): string;
