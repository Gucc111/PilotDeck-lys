export function resolveInstallerProxy(input?: {
  env?: Record<string, string | undefined>;
  configText?: string;
}): { url: string; noProxy: string; source: "env" | "config" } | undefined;
