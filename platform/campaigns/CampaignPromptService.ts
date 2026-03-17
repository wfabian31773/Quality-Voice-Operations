import { getCampaignTypeDefinition } from './CampaignTypeRegistry';
import type { CampaignType } from './types';

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceToken(prompt: string, token: string, value: string): string {
  return prompt.replace(new RegExp(`\\{\\{${escapeRegExp(token)}\\}\\}`, 'g'), value);
}

export function buildCampaignTypePromptAugmentation(
  campaignType: string,
  campaignConfig: Record<string, unknown>,
  contactMetadata: Record<string, unknown>,
  contactName: string | null,
): string | null {
  const typeDef = getCampaignTypeDefinition(campaignType);
  if (!typeDef || typeDef.type === 'outbound_call' || !typeDef.promptTemplate) {
    return null;
  }

  let prompt = typeDef.promptTemplate;

  const businessName = (campaignConfig.businessName as string) ?? 'our business';
  prompt = replaceToken(prompt, 'businessName', businessName);

  if (contactName) {
    prompt = replaceToken(prompt, 'contactName', contactName);
  }

  for (const field of typeDef.configFields) {
    if (!field.key.endsWith('Field')) continue;

    const canonicalToken = field.key.replace(/Field$/, '');
    const customMetaKey = campaignConfig[field.key];
    const metaKey = typeof customMetaKey === 'string' && customMetaKey
      ? customMetaKey
      : canonicalToken;

    let metaValue = contactMetadata[metaKey];
    if (metaValue === undefined || metaValue === null) {
      const metaKeyLower = metaKey.toLowerCase();
      const match = Object.keys(contactMetadata).find((k) => k.toLowerCase() === metaKeyLower);
      if (match) metaValue = contactMetadata[match];
    }
    if (metaValue !== undefined && metaValue !== null) {
      prompt = replaceToken(prompt, canonicalToken, String(metaValue));
    }
  }

  for (const [key, value] of Object.entries(contactMetadata)) {
    if (value !== undefined && value !== null) {
      prompt = replaceToken(prompt, key, String(value));
    }
  }

  for (const [key, value] of Object.entries(campaignConfig)) {
    if (typeof value === 'string') {
      prompt = replaceToken(prompt, key, value);
    }
  }

  prompt = prompt.replace(/\{\{[^}]+\}\}/g, '');

  return prompt;
}

export function classifyTypeDisposition(
  campaignType: string,
  transcript: string,
): string {
  const typeDef = getCampaignTypeDefinition(campaignType);
  if (!typeDef || typeDef.dispositions.length === 0) {
    return 'no_response';
  }

  const lower = transcript.toLowerCase();

  switch (typeDef.type as CampaignType) {
    case 'appointment_reminder': {
      if (/\b(cancel|canceling|cancelling|don'?t want|remove)\b/.test(lower)) return 'cancelled';
      if (/\b(reschedule|different (time|day|date)|change.*appointment|move.*appointment)\b/.test(lower)) return 'rescheduled';
      if (/\b(confirm|yes|i'?ll be there|see you|sounds good|that works|perfect)\b/.test(lower)) return 'confirmed';
      return 'no_response';
    }

    case 'lead_followup': {
      if (/\b(sign(ed)? up|buy|purchase|go ahead|let'?s do it|ready to start|converted|booked)\b/.test(lower)) return 'converted';
      if (/\b(call (me )?back|another time|later|busy right now|call again)\b/.test(lower)) return 'callback_requested';
      if (/\b(not interested|no thanks|don'?t need|pass|decline)\b/.test(lower)) return 'not_interested';
      if (/\b(interested|tell me more|sounds (good|interesting)|learn more|want to know)\b/.test(lower)) return 'interested';
      return 'no_response';
    }

    case 'review_request': {
      if (/\b(left a review|posted|wrote a review|reviewed|five stars?|5 stars?)\b/.test(lower)) return 'review_left';
      if (/\b(don'?t want to|no review|rather not|decline|pass)\b/.test(lower)) return 'declined';
      if (/\b(feedback|complaint|issue|problem|concern|suggestion|could be better|improvement)\b/.test(lower)) return 'feedback_given';
      if (/\b(sure|happy to|i'?ll leave|i can do that|of course)\b/.test(lower)) return 'review_left';
      return 'no_response';
    }

    case 'customer_reactivation': {
      if (/\b(come back|schedule|book|appointment|sign up again|reactivate|returning)\b/.test(lower)) return 'reactivated';
      if (/\b(not interested|moved|switched|no longer|different provider)\b/.test(lower)) return 'not_interested';
      if (/\b(maybe|thinking|consider|let me think|possible|might)\b/.test(lower)) return 'interested';
      return 'no_response';
    }

    case 'upsell': {
      if (/\b(upgrade|sign me up|go ahead|accept|i'?ll take it|let'?s do it|buy|purchase)\b/.test(lower)) return 'accepted';
      if (/\b(not interested|no thanks|don'?t need|pass|decline|happy with what i have|current plan is fine)\b/.test(lower)) return 'declined';
      if (/\b(tell me more|sounds (good|interesting)|learn more|how much|what'?s the price|details)\b/.test(lower)) return 'interested';
      return 'no_response';
    }

    default:
      return 'no_response';
  }
}
