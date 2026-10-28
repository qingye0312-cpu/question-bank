export type WordExportAccess = {
  auth_type?: string;
  account_status?: string;
  permissions?: string[];
  capabilities?: string[];
} | undefined | null;

/** Word export is an explicit privilege; incomplete or unknown access is denied. */
export function hasWordExportPermission(access: WordExportAccess): boolean {
  if (!access) return false;
  if (access.auth_type === 'key') {
    return Array.isArray(access.capabilities) && access.capabilities.includes('maintainer:manage');
  }
  return access.auth_type === 'password'
    && access.account_status === 'approved'
    && Array.isArray(access.permissions)
    && access.permissions.includes('export');
}
