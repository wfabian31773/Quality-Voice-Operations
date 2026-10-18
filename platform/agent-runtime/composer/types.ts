import type { AgentTemplate, Phrase, TemplateLanguage } from '../../agent-templates/shared';
import type { ReadCachePolicy } from '../../callcore/contracts';

export type { AgentTemplate, Phrase, TemplateLanguage };

/** A tool as the voice session exposes it to the model. */
export interface ComposedTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** The business's own settings, from data that already exists (agent metadata and its saved prompt). */
export interface ComposerTenantConfig {
  businessName?: string | null;
  /** Free-text facts the business saved (hours, address, services); null when it saved none. */
  businessDetails?: string | null;
}

/** Facts about this call known before it starts. */
export interface ComposerCallFacts {
  /** The call's starting language ('en', 'es-US', …); anything but Spanish is English. */
  language?: string | null;
  /** The runtime's caller-ID prompt line; empty when the caller ID is withheld. */
  callerIdLine?: string | null;
}

/**
 * What the runtime's tool bridge needs to run a composed agent's contract
 * tools: names, the template's asks and the after-write lines. Data only.
 */
export interface ContractToolBinding {
  /** External tool name → platform action name: contract actions and the template's reads only. */
  actions: Readonly<Record<string, string>>;
  /** askId → the template's phrasing, for the selected contracts' slots. */
  asks: Readonly<Record<string, Phrase>>;
  /** Commit action → the template's after-write line (`{{readback}}` filled by the bridge). */
  afterWrite: Readonly<Record<string, Phrase>>;
  /** Said after an after-write line while SMS is off. */
  textWillFollow: Phrase;
  /** Action → input paths of slots held from caller ID (a caller-ID reference there is left for the server to fill). */
  callerIdPaths: Readonly<Record<string, readonly string[]>>;
  /**
   * Read action → its cache policy ('call': the same arguments give the same
   * result for the whole call), from the contract or the read's own data.
   * Reads not listed are run every time.
   */
  cacheable: Readonly<Record<string, ReadCachePolicy>>;
}

export interface ComposedAgent {
  /** 'id@version' of the template. */
  templateKey: string;
  language: TemplateLanguage;
  prompt: string;
  greeting: string;
  tools: ComposedTool[];
  keyterms: string[];
  contractTools: ContractToolBinding;
}
