export type WordExportAccess = {
  auth_type?: string;
  account_status?: string;
  permissions?: string[];
  capabilities?: string[];
} | undefined | null;

/** Read a permission list defensively; malformed cloud state must not grant access. */
export function hasPermission(value: unknown, permission: string): boolean {
  return Array.isArray(value) && value.includes(permission);
}

/** Word export is an explicit privilege; incomplete or unknown access is denied. */
export function hasWordExportPermission(access: WordExportAccess): boolean {
  if (!access) return false;
  if (access.auth_type === 'key') {
    return hasPermission(access.capabilities, 'maintainer:manage');
  }
  return access.auth_type === 'password'
    && access.account_status === 'approved'
    && hasPermission(access.permissions, 'export');
}
