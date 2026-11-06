export const GATE_GRANTS: Record<string, string[]>;
export function readKey(text: string, key: string): string | undefined;
export function setKey(text: string, key: string, value: string): string;
export function fillRootEnv(text: string, random?: () => string): { text: string; changed: string[] };
export function fillSwitchEnv(text: string, sha: string, random?: () => string): { text: string; changed: string[] };
export function gateTokensFile(rootEnvText: string): Record<string, string>;
