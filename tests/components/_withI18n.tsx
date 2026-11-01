import * as React from 'react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../client-app/src/lib/i18n';

void React;

export async function readyI18n(
  namespaces: string[] = ['common', 'admin', 'tenant', 'marketing'],
): Promise<typeof i18n> {
  await i18n.changeLanguage('en');
  await i18n.loadNamespaces(namespaces);
  return i18n;
}

export function WithI18n({ children }: { children: React.ReactNode }) {
  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}
