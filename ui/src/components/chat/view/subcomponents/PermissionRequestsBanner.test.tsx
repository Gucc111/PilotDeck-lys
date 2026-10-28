// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createTestI18n } from '../../../../i18n/testInstance';
import PermissionRequestsBanner from './PermissionRequestsBanner';
afterEach(cleanup);
it('keeps ordinary conversation allow-and-remember behavior by default', async () => {
  const i18n = await createTestI18n('en');
  const decide = vi.fn(); const grant = vi.fn(() => ({ success: true }));
  render(<I18nextProvider i18n={i18n}><PermissionRequestsBanner pendingPermissionRequests={[{ requestId: 'ordinary-request', toolName: 'bash', input: { command: 'git status' } }]} handlePermissionDecision={decide} handleGrantToolPermission={grant}/></I18nextProvider>);
  fireEvent.click(screen.getByRole('button', { name: i18n.t('permissionBanner.allowRemember', { ns: 'chat' }) }));
  expect(grant).toHaveBeenCalledWith({ entry: 'bash:git status:*', toolName: 'bash' });
  expect(decide).toHaveBeenCalledWith(['ordinary-request'], { allow: true, rememberEntry: 'bash:git status:*' });
});
