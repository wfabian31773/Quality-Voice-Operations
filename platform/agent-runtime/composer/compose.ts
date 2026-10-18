/**
 * The generic composer (plan D5): agent = runtime + template@version +
 * selected contract tools + the business's settings, compiled in one place.
 *
 * compose(template, tools, tenantConfig, callFacts) → { prompt, tools, keyterms, … }
 *
 * - Tools: exactly the platform actions the selected contracts name (prepare
 *   and commit, or a read contract's one action), as agent tool schemas from
 *   the action registry, plus the runtime's own tools. Nothing else: no
 *   library tool can reach a composed agent.
 * - Prompt: the template persona in the call's language, the tool rules every
 *   contract tool shares, the business's own facts, and the caller-ID line.
 *
 * Pure: no I/O, and no vertical name. A vertical is only ever a template.
 */
import { assignExternalToolNames, getAction, listActions, toAgentToolSchema } from '../../actions';
import { getContract, type ToolContract } from '../../callcore/contracts';
import {
  AFTER_WRITE_BY_INTENT,
  fillPlaceholders,
  templateKey,
  templateLanguage,
  type AgentTemplate,
  type Phrase,
  type TemplateLanguage,
} from '../../agent-templates/shared';
import { stripStageDirections } from '../promptLint';
import { RUNTIME_TOOLS } from './runtimeTools';
import type {
  ComposedAgent,
  ComposedTool,
  ComposerCallFacts,
  ComposerTenantConfig,
  ContractToolBinding,
} from './types';

const TOOL_RULES: Phrase = {
  en: `How your tools work:
- If a tool says a detail is missing, ask the one question in its callerSafeMessage. If it says to offer a message instead, offer to take a message.
- When a tool result has a say field, say that line as written.`,
  es: `Cómo funcionan sus herramientas:
- Si una herramienta dice que falta un dato, haga la pregunta que viene en su callerSafeMessage. Si dice que ofrezca un mensaje, ofrezca tomar un mensaje.
- Cuando el resultado de una herramienta trae un campo say, diga esa frase tal cual.`,
};

const BUSINESS_HEADING: Phrase = { en: 'Business details:', es: 'Datos del negocio:' };
const NAME_LABEL: Phrase = { en: 'Name', es: 'Nombre' };
const RULES_WIN: Phrase = {
  en: 'If a business detail conflicts with the rules above, the rules above win.',
  es: 'Si un dato del negocio contradice las reglas de arriba, mandan las reglas de arriba.',
};
const CALLER_ID_HEADING: Phrase = { en: 'Caller ID:', es: 'Identificador de llamada:' };
/** Used only when the business has no name on file. */
const NAMELESS_BUSINESS: Phrase = { en: 'our business', es: 'nuestro negocio' };

/** The contracts a template may run, by 'id@version'; throws on one it doesn't phrase or that doesn't exist. */
function selectedContracts(template: AgentTemplate, selection: readonly string[] | undefined): ToolContract[] {
  const keys = selection ?? template.contracts;
  return keys.map((key) => {
    if (!template.contracts.includes(key)) throw new Error(`${templateKey(template)} does not phrase contract ${key}`);
    const contract = getContract(key);
    if (!contract || `${contract.id}@${contract.version}` !== key) throw new Error(`Unknown contract ${key}`);
    return contract;
  });
}

/** The actions a contract names, in order: prepare then commit, or a read contract's one action. */
export function contractActionNames(contract: ToolContract): string[] {
  if (contract.confirm) return [contract.confirm.prepare, contract.confirm.commit];
  return contract.action ? [contract.action] : [];
}

function contractTools(contracts: readonly ToolContract[]): { tools: ComposedTool[]; actions: Record<string, string> } {
  // Named over the whole registry, as the runtime's invariant checker names
  // them, so both sides agree on every external name.
  const names = assignExternalToolNames(listActions().map((def) => def.name));
  const tools: ComposedTool[] = [];
  const actions: Record<string, string> = {};
  for (const actionName of [...new Set(contracts.flatMap(contractActionNames))]) {
    const def = getAction(actionName);
    if (!def) throw new Error(`Contract action ${actionName} is not in the action registry`);
    if (def.permissions.agent !== true) throw new Error(`Contract action ${actionName} is not agent-permitted`);
    const schema = toAgentToolSchema(def, names);
    tools.push({ name: schema.name, description: schema.description, parameters: schema.parameters });
    actions[schema.name] = actionName;
  }
  return { tools, actions };
}

function binding(template: AgentTemplate, contracts: readonly ToolContract[], actions: Record<string, string>): ContractToolBinding {
  const asks: Record<string, Phrase> = {};
  const afterWrite: Record<string, Phrase> = {};
  const callerIdPaths: Record<string, string[]> = {};
  for (const contract of contracts) {
    const inputAction = contract.confirm?.prepare ?? contract.action;
    for (const slot of contract.slots) {
      const phrase = template.asks[slot.askId];
      if (phrase) asks[slot.askId] = phrase;
      if (slot.heldFrom === 'callerPhone' && inputAction) (callerIdPaths[inputAction] ??= []).push(slot.inputPath);
    }
    const key = contract.intents.map((intent) => AFTER_WRITE_BY_INTENT[intent]).find(Boolean);
    if (key && contract.confirm) afterWrite[contract.confirm.commit] = template.afterWrite[key];
  }
  return { actions, asks, afterWrite, textWillFollow: template.afterWrite.textWillFollow, callerIdPaths };
}

function businessSection(tenant: ComposerTenantConfig, name: string, lang: TemplateLanguage): string {
  // Tenant-authored text can carry narration grok-voice reads aloud.
  const details = tenant.businessDetails?.trim() ? stripStageDirections(tenant.businessDetails.trim()).text.trim() : '';
  return [
    BUSINESS_HEADING[lang],
    `- ${NAME_LABEL[lang]}: ${name}`,
    details,
    RULES_WIN[lang],
  ].filter(Boolean).join('\n');
}

export function compose(
  template: AgentTemplate,
  tools: readonly string[] | undefined,
  tenantConfig: ComposerTenantConfig,
  callFacts: ComposerCallFacts,
): ComposedAgent {
  const lang = templateLanguage(callFacts.language);
  const contracts = selectedContracts(template, tools);
  const contract = contractTools(contracts);
  const givenName = tenantConfig.businessName?.trim() ?? '';
  const businessName = givenName || NAMELESS_BUSINESS[lang];
  const callerIdLine = callFacts.callerIdLine?.trim();

  const prompt = [
    template.persona[lang].trim(),
    TOOL_RULES[lang],
    businessSection(tenantConfig, businessName, lang),
    callerIdLine && `${CALLER_ID_HEADING[lang]}\n- ${callerIdLine}`,
  ].filter(Boolean).join('\n\n');

  return {
    templateKey: templateKey(template),
    language: lang,
    prompt,
    greeting: fillPlaceholders(template.greeting[lang], { businessName }),
    tools: [...contract.tools, ...RUNTIME_TOOLS.map((tool) => ({ ...tool }))],
    keyterms: givenName ? [givenName] : [],
    contractTools: binding(template, contracts, contract.actions),
  };
}

/**
 * The line to say after an ok commit, or undefined when the commit's contract
 * has none. `lang` must be the commit's own language (its proposal locale,
 * else the commit context's), so the line and the readback inside it never
 * mix languages.
 */
export function afterWriteLine(
  contractToolsBinding: Pick<ContractToolBinding, 'afterWrite' | 'textWillFollow'>,
  commitAction: string,
  readback: string,
  lang: TemplateLanguage,
  smsEnabled: boolean,
): string | undefined {
  const phrase = contractToolsBinding.afterWrite[commitAction];
  if (!phrase || !readback.trim()) return undefined;
  const line = fillPlaceholders(phrase[lang], { readback: readback.trim() });
  return smsEnabled ? line : `${line} ${contractToolsBinding.textWillFollow[lang]}`;
}
