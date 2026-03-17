import type { CampaignType, TypeDisposition } from './types';

export interface CampaignTypeDefinition {
  type: CampaignType;
  label: string;
  description: string;
  icon: string;
  dispositions: Array<{ value: string; label: string }>;
  primaryMetricLabel: string;
  primaryDispositions: string[];
  promptTemplate: string;
  configFields: Array<{
    key: string;
    label: string;
    type: 'text' | 'url' | 'number' | 'boolean';
    placeholder?: string;
    helpText?: string;
    required?: boolean;
  }>;
  contactMetadataFields: Array<{
    key: string;
    label: string;
    helpText?: string;
  }>;
}

const CAMPAIGN_TYPES: Record<CampaignType, CampaignTypeDefinition> = {
  outbound_call: {
    type: 'outbound_call',
    label: 'General Outbound',
    description: 'Generic outbound calling campaign with standard conversation flow.',
    icon: 'Phone',
    dispositions: [],
    primaryMetricLabel: 'Completion Rate',
    primaryDispositions: ['completed'],
    promptTemplate: '',
    configFields: [],
    contactMetadataFields: [],
  },
  appointment_reminder: {
    type: 'appointment_reminder',
    label: 'Appointment Reminder',
    description: 'Call patients or customers to confirm upcoming appointments. Track confirmations, reschedules, and cancellations.',
    icon: 'Calendar',
    dispositions: [
      { value: 'confirmed', label: 'Confirmed' },
      { value: 'rescheduled', label: 'Rescheduled' },
      { value: 'cancelled', label: 'Cancelled' },
      { value: 'no_response', label: 'No Response' },
    ],
    primaryMetricLabel: 'Confirmation Rate',
    primaryDispositions: ['confirmed'],
    promptTemplate: `You are a friendly appointment reminder assistant calling on behalf of {{businessName}}.

Your goal is to confirm the customer's upcoming appointment.

Key information to convey:
- Appointment date and time: {{appointmentDate}} at {{appointmentTime}}
- Provider/staff: {{providerName}}
- Location: {{location}}

Conversation flow:
1. Greet the customer by name and identify yourself as calling from {{businessName}}
2. Mention their upcoming appointment details
3. Ask if they can confirm their attendance
4. If they need to reschedule, offer to help find a new time
5. If they want to cancel, acknowledge and confirm the cancellation
6. Thank them and end the call professionally

Keep the call brief and friendly. If you reach voicemail, leave a clear message with the appointment details and a callback number.`,
    configFields: [
      { key: 'appointmentDateField', label: 'Appointment Date Field', type: 'text', placeholder: 'appointmentDate', helpText: 'Contact metadata field containing the appointment date' },
      { key: 'appointmentTimeField', label: 'Appointment Time Field', type: 'text', placeholder: 'appointmentTime', helpText: 'Contact metadata field containing the appointment time' },
      { key: 'providerNameField', label: 'Provider Name Field', type: 'text', placeholder: 'providerName', helpText: 'Contact metadata field for the provider or staff name' },
      { key: 'locationField', label: 'Location Field', type: 'text', placeholder: 'location', helpText: 'Contact metadata field for the appointment location' },
      { key: 'allowReschedule', label: 'Allow Rescheduling', type: 'boolean', helpText: 'Whether the agent can help reschedule appointments' },
    ],
    contactMetadataFields: [
      { key: 'appointmentDate', label: 'Appointment Date', helpText: 'e.g. March 20, 2026' },
      { key: 'appointmentTime', label: 'Appointment Time', helpText: 'e.g. 2:30 PM' },
      { key: 'providerName', label: 'Provider Name', helpText: 'e.g. Dr. Smith' },
      { key: 'location', label: 'Location', helpText: 'e.g. 123 Main St, Suite 200' },
    ],
  },
  lead_followup: {
    type: 'lead_followup',
    label: 'Lead Follow-Up',
    description: 'Follow up with leads from forms, ads, or referrals. Qualify interest and schedule next steps.',
    icon: 'UserPlus',
    dispositions: [
      { value: 'interested', label: 'Interested' },
      { value: 'not_interested', label: 'Not Interested' },
      { value: 'callback_requested', label: 'Callback Requested' },
      { value: 'converted', label: 'Converted' },
      { value: 'no_response', label: 'No Response' },
    ],
    primaryMetricLabel: 'Conversion Rate',
    primaryDispositions: ['converted', 'interested'],
    promptTemplate: `You are a professional follow-up specialist calling on behalf of {{businessName}}.

You are following up with a lead who recently expressed interest.

Lead details:
- Source: {{source}}
- Interest: {{productInterest}}

Conversation flow:
1. Greet the lead by name and introduce yourself from {{businessName}}
2. Reference how they connected with you (form submission, ad, referral, etc.)
3. Ask about their current needs and timeline
4. Address any questions or concerns
5. If interested, schedule a next step (demo, consultation, appointment)
6. If not interested, thank them for their time

Be consultative, not pushy. Listen actively and match your pitch to their needs. Goal: {{followupGoal}}`,
    configFields: [
      { key: 'sourceField', label: 'Lead Source Field', type: 'text', placeholder: 'source', helpText: 'Contact metadata field for where the lead came from' },
      { key: 'productInterestField', label: 'Product Interest Field', type: 'text', placeholder: 'productInterest', helpText: 'Contact metadata field for what they showed interest in' },
      { key: 'followupGoal', label: 'Follow-up Goal', type: 'text', placeholder: 'Schedule a demo', helpText: 'Primary goal for each follow-up call' },
    ],
    contactMetadataFields: [
      { key: 'source', label: 'Lead Source', helpText: 'e.g. Website form, Google Ads' },
      { key: 'productInterest', label: 'Product Interest', helpText: 'e.g. Enterprise plan, Dental package' },
    ],
  },
  review_request: {
    type: 'review_request',
    label: 'Review Request',
    description: 'Call customers after service completion to collect feedback and encourage online reviews.',
    icon: 'Star',
    dispositions: [
      { value: 'review_left', label: 'Review Left' },
      { value: 'feedback_given', label: 'Feedback Given' },
      { value: 'declined', label: 'Declined' },
      { value: 'no_response', label: 'No Response' },
    ],
    primaryMetricLabel: 'Review Completion Rate',
    primaryDispositions: ['review_left'],
    promptTemplate: `You are a friendly customer experience specialist calling on behalf of {{businessName}}.

You are reaching out to gather feedback after a recent service.

Service details:
- Service: {{serviceName}}

Conversation flow:
1. Greet the customer by name and introduce yourself from {{businessName}}
2. Ask about their recent experience with {{serviceName}}
3. Listen to their feedback — positive or negative
4. If they had a positive experience (rating 4-5 out of 5), kindly ask if they would leave a review
5. If they agree, let them know they will receive a text with a review link
6. If they had concerns, acknowledge them, apologize, and assure them someone will follow up
7. Thank them for their time and feedback

Be genuine and appreciative. Never pressure anyone to leave a review. Focus on collecting honest feedback first.`,
    configFields: [
      { key: 'serviceNameField', label: 'Service Name Field', type: 'text', placeholder: 'serviceName', helpText: 'Contact metadata field for the service that was provided' },
      { key: 'reviewUrl', label: 'Review URL', type: 'url', placeholder: 'https://g.page/your-business/review', helpText: 'Link to your Google/Yelp review page (sent via SMS to satisfied customers)' },
      { key: 'minimumSatisfactionToAskReview', label: 'Min Satisfaction for Review Ask', type: 'number', placeholder: '4', helpText: 'Minimum rating (1-5) before asking for a review' },
    ],
    contactMetadataFields: [
      { key: 'serviceName', label: 'Service Name', helpText: 'e.g. Dental cleaning, HVAC repair' },
      { key: 'serviceDate', label: 'Service Date', helpText: 'e.g. March 15, 2026' },
    ],
  },
  customer_reactivation: {
    type: 'customer_reactivation',
    label: 'Customer Reactivation',
    description: 'Re-engage inactive customers with personalized outreach and special offers to win them back.',
    icon: 'RefreshCw',
    dispositions: [
      { value: 'reactivated', label: 'Reactivated' },
      { value: 'interested', label: 'Interested' },
      { value: 'not_interested', label: 'Not Interested' },
      { value: 'no_response', label: 'No Response' },
    ],
    primaryMetricLabel: 'Win-Back Rate',
    primaryDispositions: ['reactivated'],
    promptTemplate: `You are a customer relations specialist calling on behalf of {{businessName}}.

You are reaching out to a valued customer who hasn't visited or engaged recently.

Conversation flow:
1. Greet the customer warmly by name and introduce yourself from {{businessName}}
2. Mention that you noticed it's been a while since their last visit and you wanted to check in
3. Ask if there's a reason they haven't been back — listen carefully to any concerns
4. If they had a negative experience, acknowledge it and let them know things have improved
5. Present any special offer or incentive: {{offer}}
6. If interested, help them schedule their next visit or purchase
7. Thank them regardless of the outcome

Be warm, genuine, and non-aggressive. The goal is to rebuild the relationship, not just make a sale. {{reengagementMessage}}`,
    configFields: [
      { key: 'inactiveDaysThreshold', label: 'Inactive Days Threshold', type: 'number', placeholder: '90', helpText: 'Number of days since last interaction to consider a customer inactive' },
      { key: 'offerField', label: 'Offer Field', type: 'text', placeholder: 'offer', helpText: 'Contact metadata field for the re-engagement offer' },
      { key: 'reengagementMessage', label: 'Re-engagement Message', type: 'text', placeholder: 'We have new services you might enjoy', helpText: 'Additional context for the re-engagement conversation' },
    ],
    contactMetadataFields: [
      { key: 'lastVisitDate', label: 'Last Visit Date', helpText: 'e.g. December 10, 2025' },
      { key: 'offer', label: 'Special Offer', helpText: 'e.g. 20% off your next visit' },
    ],
  },
  upsell: {
    type: 'upsell',
    label: 'Upsell',
    description: 'Contact existing customers with upgrade opportunities, add-on services, or premium offerings.',
    icon: 'TrendingUp',
    dispositions: [
      { value: 'accepted', label: 'Accepted' },
      { value: 'interested', label: 'Interested' },
      { value: 'declined', label: 'Declined' },
      { value: 'no_response', label: 'No Response' },
    ],
    primaryMetricLabel: 'Acceptance Rate',
    primaryDispositions: ['accepted'],
    promptTemplate: `You are a customer success specialist calling on behalf of {{businessName}}.

You are reaching out to an existing customer about an upgrade opportunity.

Customer details:
- Current product/service: {{currentProduct}}
- Suggested upgrade: {{upsellProduct}}
- Special offer: {{discount}}

Conversation flow:
1. Greet the customer by name and introduce yourself from {{businessName}}
2. Thank them for being a valued customer
3. Briefly discuss how they're finding their current {{currentProduct}}
4. Naturally transition to the upgrade opportunity and its benefits
5. If there's a special offer, present it: {{discount}}
6. If interested, guide them through next steps
7. If they need time, respect that and offer to follow up later
8. Thank them for their time

Be helpful and value-focused, not salesy. Frame the upsell as a way to get more value from their investment.`,
    configFields: [
      { key: 'currentProductField', label: 'Current Product Field', type: 'text', placeholder: 'currentProduct', helpText: 'Contact metadata field for their current product or plan' },
      { key: 'upsellProductField', label: 'Upsell Product Field', type: 'text', placeholder: 'upsellProduct', helpText: 'Contact metadata field for the upgrade being offered' },
      { key: 'discountField', label: 'Discount Field', type: 'text', placeholder: 'discount', helpText: 'Contact metadata field for any special discount or offer' },
    ],
    contactMetadataFields: [
      { key: 'currentProduct', label: 'Current Product', helpText: 'e.g. Basic Plan, Standard Package' },
      { key: 'upsellProduct', label: 'Upsell Product', helpText: 'e.g. Premium Plan, Enterprise Package' },
      { key: 'discount', label: 'Discount/Offer', helpText: 'e.g. 15% off for the first 3 months' },
    ],
  },
};

export function getCampaignTypeDefinition(type: string): CampaignTypeDefinition | null {
  return CAMPAIGN_TYPES[type as CampaignType] ?? null;
}

export function getAllCampaignTypes(): CampaignTypeDefinition[] {
  return Object.values(CAMPAIGN_TYPES);
}

export function getValidCampaignTypes(): string[] {
  return Object.keys(CAMPAIGN_TYPES);
}

export function getDispositionsForType(type: string): Array<{ value: string; label: string }> {
  const def = getCampaignTypeDefinition(type);
  return def?.dispositions ?? [];
}

export function isValidDisposition(type: string, disposition: string): boolean {
  const dispositions = getDispositionsForType(type);
  if (dispositions.length === 0) return true;
  return dispositions.some((d) => d.value === disposition);
}
