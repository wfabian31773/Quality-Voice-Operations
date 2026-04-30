import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';
import type { TenantId } from '../core/types';

const logger = createLogger('CHECKLIST_SERVICE');

export interface ChecklistStep {
  key: string;
  label: string;
  description: string;
  completed: boolean;
  completedAt: string | null;
  link: string;
  order: number;
}

export interface ChecklistState {
  steps: ChecklistStep[];
  completedCount: number;
  totalCount: number;
  allComplete: boolean;
}

export const SUPPORTED_CHECKLIST_LOCALES = ['en', 'es', 'pt-BR', 'fr', 'de'] as const;
export type ChecklistLocale = (typeof SUPPORTED_CHECKLIST_LOCALES)[number];
export const DEFAULT_CHECKLIST_LOCALE: ChecklistLocale = 'en';

interface ChecklistStepShape {
  key: string;
  link: string;
  order: number;
}

const CHECKLIST_STEPS: ChecklistStepShape[] = [
  { key: 'assign_phone', link: '/phone-numbers', order: 1 },
  { key: 'enable_widget', link: '/widget', order: 2 },
  { key: 'attach_knowledge', link: '/knowledge-base', order: 3 },
  { key: 'customize_greeting', link: '', order: 4 },
  { key: 'test_call', link: '/calls', order: 5 },
  { key: 'publish_agent', link: '', order: 6 },
];

export const CHECKLIST_STEP_TRANSLATIONS: Record<
  ChecklistLocale,
  Record<string, { label: string; description: string }>
> = {
  en: {
    assign_phone: {
      label: 'Assign Phone Number',
      description: 'Link a phone number to your agent so it can receive calls',
    },
    enable_widget: {
      label: 'Enable Web Widget',
      description: 'Set up a chat/voice widget for your website',
    },
    attach_knowledge: {
      label: 'Attach Knowledge Base',
      description: 'Add knowledge base articles to help your agent answer questions',
    },
    customize_greeting: {
      label: 'Customize Greeting',
      description: 'Personalize the greeting message your agent uses',
    },
    test_call: {
      label: 'Run Test Call',
      description: 'Make a test call to verify your agent is working correctly',
    },
    publish_agent: {
      label: 'Publish Agent',
      description: 'Set your agent to active and start handling real calls',
    },
  },
  es: {
    assign_phone: {
      label: 'Asignar número de teléfono',
      description: 'Vincula un número de teléfono a tu agente para que pueda recibir llamadas',
    },
    enable_widget: {
      label: 'Activar el widget web',
      description: 'Configura un widget de chat/voz para tu sitio web',
    },
    attach_knowledge: {
      label: 'Adjuntar base de conocimientos',
      description: 'Añade artículos de la base de conocimientos para ayudar a tu agente a responder preguntas',
    },
    customize_greeting: {
      label: 'Personalizar el saludo',
      description: 'Personaliza el mensaje de saludo que utiliza tu agente',
    },
    test_call: {
      label: 'Hacer una llamada de prueba',
      description: 'Realiza una llamada de prueba para verificar que tu agente funciona correctamente',
    },
    publish_agent: {
      label: 'Publicar agente',
      description: 'Activa tu agente y empieza a atender llamadas reales',
    },
  },
  'pt-BR': {
    assign_phone: {
      label: 'Atribuir número de telefone',
      description: 'Vincule um número de telefone ao seu agente para que ele possa receber chamadas',
    },
    enable_widget: {
      label: 'Ativar o widget para o site',
      description: 'Configure um widget de chat/voz para o seu site',
    },
    attach_knowledge: {
      label: 'Anexar base de conhecimento',
      description: 'Adicione artigos da base de conhecimento para ajudar seu agente a responder a perguntas',
    },
    customize_greeting: {
      label: 'Personalizar saudação',
      description: 'Personalize a mensagem de saudação que seu agente utiliza',
    },
    test_call: {
      label: 'Fazer uma chamada de teste',
      description: 'Faça uma chamada de teste para verificar se o seu agente está funcionando corretamente',
    },
    publish_agent: {
      label: 'Publicar agente',
      description: 'Ative seu agente e comece a atender chamadas reais',
    },
  },
  fr: {
    assign_phone: {
      label: 'Attribuer un numéro de téléphone',
      description: 'Associez un numéro de téléphone à votre agent pour qu’il puisse recevoir des appels',
    },
    enable_widget: {
      label: 'Activer le widget Web',
      description: 'Configurez un widget de chat ou vocal pour votre site Web',
    },
    attach_knowledge: {
      label: 'Associer une base de connaissances',
      description: 'Ajoutez des articles de base de connaissances pour aider votre agent à répondre aux questions',
    },
    customize_greeting: {
      label: 'Personnaliser le message d’accueil',
      description: 'Personnalisez le message d’accueil utilisé par votre agent',
    },
    test_call: {
      label: 'Lancer un appel de test',
      description: 'Passez un appel de test pour vérifier que votre agent fonctionne correctement',
    },
    publish_agent: {
      label: 'Publier l’agent',
      description: 'Activez votre agent et commencez à traiter de vrais appels',
    },
  },
  de: {
    assign_phone: {
      label: 'Telefonnummer zuweisen',
      description: 'Verknüpfen Sie eine Telefonnummer mit Ihrem Agenten, damit er Anrufe entgegennehmen kann',
    },
    enable_widget: {
      label: 'Web-Widget aktivieren',
      description: 'Richten Sie ein Chat- oder Sprach-Widget für Ihre Website ein',
    },
    attach_knowledge: {
      label: 'Wissensdatenbank anhängen',
      description: 'Fügen Sie Artikel aus der Wissensdatenbank hinzu, damit Ihr Agent Fragen beantworten kann',
    },
    customize_greeting: {
      label: 'Begrüßung anpassen',
      description: 'Personalisieren Sie die Begrüßungsnachricht, die Ihr Agent verwendet',
    },
    test_call: {
      label: 'Testanruf durchführen',
      description: 'Führen Sie einen Testanruf durch, um zu prüfen, ob Ihr Agent korrekt funktioniert',
    },
    publish_agent: {
      label: 'Agent veröffentlichen',
      description: 'Aktivieren Sie Ihren Agenten und beginnen Sie, echte Anrufe zu bearbeiten',
    },
  },
};

const SUPPORTED_LOCALE_SET: Set<string> = new Set(SUPPORTED_CHECKLIST_LOCALES);

/**
 * Map a BCP-47 tag to one of the supported checklist locales, falling back
 * to `DEFAULT_CHECKLIST_LOCALE` for unknown input. Mirrors the client-side
 * `resolveSupportedLanguage` in `client-app/src/lib/i18n.ts`.
 */
export function normalizeChecklistLocale(input: string | undefined | null): ChecklistLocale {
  if (!input) return DEFAULT_CHECKLIST_LOCALE;
  const trimmed = input.trim();
  if (!trimmed) return DEFAULT_CHECKLIST_LOCALE;

  if (SUPPORTED_LOCALE_SET.has(trimmed)) return trimmed as ChecklistLocale;

  const ciExact = SUPPORTED_CHECKLIST_LOCALES.find(
    (code) => code.toLowerCase() === trimmed.toLowerCase(),
  );
  if (ciExact) return ciExact;

  const primary = trimmed.split('-')[0]?.toLowerCase();
  if (!primary) return DEFAULT_CHECKLIST_LOCALE;

  if (primary === 'pt') return 'pt-BR';

  const byPrimary = SUPPORTED_CHECKLIST_LOCALES.find(
    (code) => code.split('-')[0].toLowerCase() === primary,
  );
  if (byPrimary) return byPrimary;

  return DEFAULT_CHECKLIST_LOCALE;
}

/** Look up the localized label/description for a step, falling back to English. */
export function getChecklistStepCopy(
  locale: ChecklistLocale,
  key: string,
): { label: string; description: string } {
  return (
    CHECKLIST_STEP_TRANSLATIONS[locale]?.[key] ??
    CHECKLIST_STEP_TRANSLATIONS[DEFAULT_CHECKLIST_LOCALE][key] ?? {
      label: key,
      description: '',
    }
  );
}

function buildLocalizedSteps(
  locale: ChecklistLocale,
  savedState: Record<string, { completed: boolean; completedAt: string | null }>,
): ChecklistStep[] {
  return CHECKLIST_STEPS.map((step) => {
    const saved = savedState[step.key];
    const copy = getChecklistStepCopy(locale, step.key);
    return {
      key: step.key,
      label: copy.label,
      description: copy.description,
      link: step.link,
      order: step.order,
      completed: saved?.completed ?? false,
      completedAt: saved?.completedAt ?? null,
    };
  });
}

export async function getChecklistState(
  tenantId: TenantId,
  installationId: string,
  locale: ChecklistLocale = DEFAULT_CHECKLIST_LOCALE,
): Promise<ChecklistState | null> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows } = await client.query(
      `SELECT id, checklist_state, agent_id
       FROM tenant_agent_installations
       WHERE id = $1 AND tenant_id = $2 AND status = 'active'`,
      [installationId, tenantId],
    );

    await client.query('COMMIT');

    if (rows.length === 0) return null;

    const savedState = (rows[0].checklist_state as Record<string, { completed: boolean; completedAt: string | null }>) ?? {};

    const steps = buildLocalizedSteps(locale, savedState);
    const completedCount = steps.filter((s) => s.completed).length;

    return {
      steps,
      completedCount,
      totalCount: steps.length,
      allComplete: completedCount === steps.length,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to get checklist state', { tenantId, installationId, error: String(err) });
    throw err;
  } finally {
    client.release();
  }
}

export async function markStepComplete(
  tenantId: TenantId,
  installationId: string,
  stepKey: string,
  locale: ChecklistLocale = DEFAULT_CHECKLIST_LOCALE,
): Promise<{ success: boolean; error?: string; checklist?: ChecklistState }> {
  const validKeys = new Set(CHECKLIST_STEPS.map((s) => s.key));
  if (!validKeys.has(stepKey)) {
    return { success: false, error: `Invalid step key: ${stepKey}` };
  }

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows } = await client.query(
      `SELECT id, checklist_state
       FROM tenant_agent_installations
       WHERE id = $1 AND tenant_id = $2 AND status = 'active'`,
      [installationId, tenantId],
    );

    if (rows.length === 0) {
      await client.query('COMMIT');
      return { success: false, error: 'Installation not found' };
    }

    const savedState = (rows[0].checklist_state as Record<string, { completed: boolean; completedAt: string | null }>) ?? {};
    savedState[stepKey] = { completed: true, completedAt: new Date().toISOString() };

    await client.query(
      `UPDATE tenant_agent_installations SET checklist_state = $1, updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3`,
      [JSON.stringify(savedState), installationId, tenantId],
    );

    await client.query('COMMIT');

    const checklist = await getChecklistState(tenantId, installationId, locale);
    return { success: true, checklist: checklist! };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to mark step complete', { tenantId, installationId, stepKey, error: String(err) });
    return { success: false, error: 'Failed to update checklist' };
  } finally {
    client.release();
  }
}

export async function markStepIncomplete(
  tenantId: TenantId,
  installationId: string,
  stepKey: string,
  locale: ChecklistLocale = DEFAULT_CHECKLIST_LOCALE,
): Promise<{ success: boolean; error?: string; checklist?: ChecklistState }> {
  const validKeys = new Set(CHECKLIST_STEPS.map((s) => s.key));
  if (!validKeys.has(stepKey)) {
    return { success: false, error: `Invalid step key: ${stepKey}` };
  }

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows } = await client.query(
      `SELECT id, checklist_state
       FROM tenant_agent_installations
       WHERE id = $1 AND tenant_id = $2 AND status = 'active'`,
      [installationId, tenantId],
    );

    if (rows.length === 0) {
      await client.query('COMMIT');
      return { success: false, error: 'Installation not found' };
    }

    const savedState = (rows[0].checklist_state as Record<string, { completed: boolean; completedAt: string | null }>) ?? {};
    savedState[stepKey] = { completed: false, completedAt: null };

    await client.query(
      `UPDATE tenant_agent_installations SET checklist_state = $1, updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3`,
      [JSON.stringify(savedState), installationId, tenantId],
    );

    await client.query('COMMIT');

    const checklist = await getChecklistState(tenantId, installationId, locale);
    return { success: true, checklist: checklist! };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to mark step incomplete', { tenantId, installationId, stepKey, error: String(err) });
    return { success: false, error: 'Failed to update checklist' };
  } finally {
    client.release();
  }
}
