// The UI server is transport-only for permissions. It runs with the tsx loader,
// so both GET and PUT use the same schema, migration, and disk implementation
// as the gateway runtime.
export {
  DEFAULT_PERMISSION_SETTINGS,
  getPermissionSettingsPath,
  normalizePermissionEntry,
  normalizePermissionSettings,
  readPermissionSettings,
  writePermissionSettings,
} from '../../../src/permission/settings.ts';
